"""Generic, owner-defined product catalog + orders (2026-08-19) — modeled
on WooCommerce's product concept rather than anything restaurant- or
retail-specific. See models.py's `Product`/`Order`/`OrderItem`/
`ProductFieldDefinition`/`ProductRelation` docstrings for the full design
rationale: this is deliberately NOT built on top of the `IntentSchema`
framework (apis/intent_schemas.py) — a product's line items (repeated
item+quantity, price looked up from a real catalog) don't fit
`IntentField`'s flat key-value shape, so this is its own parallel table
set, same "we build the framework, the owner fills in the specific
vertical" posture applied to a genuinely different data shape.

Split into two routers, mirroring apis/pages.py's admin_router/
public_router split exactly:

- `admin_router` (gated, unchanged pattern): `Product`/
  `ProductFieldDefinition`/`ProductRelation` CRUD, the propose-then-apply
  flow, order viewing/status management, order-status-options.
  `Product` CRUD is only ever written by the owner's own direct action —
  either their own dashboard form (ProductPanel) or an explicit Apply
  click on an owner-agent-drafted proposal (propose_products below) —
  never by owner-agent directly, same higher-stakes posture as
  `IntentSchema` (a misread price directly affects what a real customer
  is quoted).
- `public_router` (no auth, mirrors the public storefront a visitor
  actually browses): catalog read/search, and `POST /cart/add` — the
  deterministic, non-LLM add-to-cart mutation shared by the ProductList
  Block, the product detail page, and the chatbot's own product cards.
  Search/mutation logic itself lives in backend/cart.py (shared with
  apis/chat.py's LLM-driven order capture — see that module's docstring
  for why it isn't here or in apis/chat.py directly).

`order_status_options` (on the AppSettings singleton) is the one piece
owner-agent writes directly (`set_order_status_options`, mirrors
`manage_review_queue`) — a status label list is cheap to adjust
afterward, unlike a schema, a price, or a custom-field definition.
"""

import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import Text, cast, func, or_, select
from sqlalchemy.orm import Session, selectinload

from apis.chat import _get_or_create_session
from apis.deps import Role, require_role
from apis.notifications import notify_owner
from apis.payments import resolve_payment_provider
from cart import apply_order_delta, count_search_products, find_active_order, search_products
from db import get_db
from models import AppSettings, Order, OrderItem, Product, ProductFieldDefinition, ProductRelation
from payments import PaymentProviderNotConfigured

FRONTEND_PUBLIC_URL = os.environ.get("FRONTEND_PUBLIC_URL", "http://localhost:3000")

admin_router = APIRouter(dependencies=[Depends(require_role(Role.admin, Role.owner))])
public_router = APIRouter()

DEFAULT_ORDER_STATUS_OPTIONS = ["received", "preparing", "ready", "delivered", "paid", "refunded"]
_PRODUCT_FIELD_TYPES = {"text", "number", "date", "note", "link"}
_RELATION_TYPES = {"bundle", "upsell"}


# --- Shared relation-summary shape (admin + public reads) --------------


class RelationSummary(BaseModel):
    relation_id: int
    product_id: int
    name: str
    price: float
    image_url: str | None
    quantity: int | None = None


def _relations_for(db: Session, product_id: int, relation_type: str) -> list[RelationSummary]:
    rows = db.execute(
        select(ProductRelation, Product)
        .join(Product, Product.id == ProductRelation.related_product_id)
        .where(ProductRelation.product_id == product_id, ProductRelation.relation_type == relation_type)
    ).all()
    return [
        RelationSummary(
            relation_id=rel.id,
            product_id=p.id,
            name=p.name,
            price=float(p.price),
            image_url=p.image_url,
            quantity=rel.quantity,
        )
        for rel, p in rows
    ]


# --- Product CRUD (admin) ------------------------------------------------


class ProductPayload(BaseModel):
    name: str
    description: str | None = None
    price: float
    tags: list[str] = []
    available: bool = True
    image_url: str | None = None
    custom_fields: dict = {}


class ProductSummary(ProductPayload):
    id: int
    created_at: datetime
    bundle_items: list[RelationSummary] = []
    upsells: list[RelationSummary] = []


def _to_product_summary(db: Session, row: Product) -> ProductSummary:
    return ProductSummary(
        id=row.id,
        name=row.name,
        description=row.description,
        price=float(row.price),
        tags=row.tags,
        available=row.available,
        image_url=row.image_url,
        custom_fields=row.custom_fields,
        created_at=row.created_at,
        bundle_items=_relations_for(db, row.id, "bundle"),
        upsells=_relations_for(db, row.id, "upsell"),
    )


class ProductListResponse(BaseModel):
    items: list[ProductSummary]
    total: int


@admin_router.get("/agent/products", response_model=ProductListResponse)
def list_products(limit: int = 100, offset: int = 0, db: Session = Depends(get_db)) -> ProductListResponse:
    """Paginated (2026-08-20, was a plain unbounded list — real UI pain
    once a catalog grows past a screenful, see the root AGENTS.md).
    `limit` defaults to 100, not `ProductPanel`'s own page size (20) —
    this default only matters to a caller that never passes the param at
    all, which today means owner-agent's `list_products` tool (its own
    description still says "returns every product," used to check for
    duplicates before `propose_products` drafts one — a small page would
    silently miss existing products past page 1). `ProductPanel` always
    passes its own explicit `limit`/`offset`, so this default doesn't
    constrain it at all."""
    total = db.execute(select(func.count()).select_from(Product)).scalar_one()
    rows = (
        db.execute(select(Product).order_by(Product.created_at.desc()).limit(limit).offset(offset)).scalars().all()
    )
    return ProductListResponse(items=[_to_product_summary(db, r) for r in rows], total=total)


@admin_router.post("/agent/products", response_model=ProductSummary)
def create_product(req: ProductPayload, db: Session = Depends(get_db)) -> ProductSummary:
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="name must not be empty.")
    if req.price < 0:
        raise HTTPException(status_code=400, detail="price must not be negative.")
    row = Product(
        name=req.name.strip(),
        description=req.description,
        price=req.price,
        tags=req.tags or [],
        available=req.available,
        image_url=req.image_url,
        custom_fields=req.custom_fields or {},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_product_summary(db, row)


@admin_router.put("/agent/products/{product_id}", response_model=ProductSummary)
def update_product(product_id: int, req: ProductPayload, db: Session = Depends(get_db)) -> ProductSummary:
    row = db.get(Product, product_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="name must not be empty.")
    if req.price < 0:
        raise HTTPException(status_code=400, detail="price must not be negative.")
    row.name = req.name.strip()
    row.description = req.description
    row.price = req.price
    row.tags = req.tags or []
    row.available = req.available
    row.image_url = req.image_url
    row.custom_fields = req.custom_fields or {}
    db.commit()
    db.refresh(row)
    return _to_product_summary(db, row)


@admin_router.delete("/agent/products/{product_id}", status_code=204)
def delete_product(product_id: int, db: Session = Depends(get_db)) -> None:
    """No undo, matches delete_intent_schema's posture. Existing
    OrderItem rows referencing this product keep their
    item_name_snapshot/unit_price_snapshot (a historical record of what
    was actually ordered) — the FK is ON DELETE SET NULL, not a cascade.
    ProductRelation rows on either side cascade (ON DELETE CASCADE) —
    a relation to a now-deleted product can't mean anything."""
    row = db.get(Product, product_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    db.delete(row)
    db.commit()


# --- Product custom-field definitions (admin) ---------------------------


class ProductFieldPayload(BaseModel):
    field_key: str
    label: str
    field_type: str = "text"
    required: bool = False


class ProductFieldSummary(ProductFieldPayload):
    id: int
    sort_order: int


def _to_field_summary(row: ProductFieldDefinition) -> ProductFieldSummary:
    return ProductFieldSummary(
        id=row.id,
        field_key=row.field_key,
        label=row.label,
        field_type=row.field_type,
        required=row.required,
        sort_order=row.sort_order,
    )


@admin_router.get("/agent/product-fields", response_model=list[ProductFieldSummary])
def list_product_fields(db: Session = Depends(get_db)) -> list[ProductFieldSummary]:
    rows = db.execute(select(ProductFieldDefinition).order_by(ProductFieldDefinition.sort_order)).scalars().all()
    return [_to_field_summary(r) for r in rows]


@admin_router.post("/agent/product-fields", response_model=ProductFieldSummary)
def create_product_field(req: ProductFieldPayload, db: Session = Depends(get_db)) -> ProductFieldSummary:
    if not req.field_key.strip():
        raise HTTPException(status_code=400, detail="field_key must not be empty.")
    if req.field_type not in _PRODUCT_FIELD_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"{req.field_type!r} isn't a supported field_type — use one of {sorted(_PRODUCT_FIELD_TYPES)}.",
        )
    if db.execute(
        select(ProductFieldDefinition).where(ProductFieldDefinition.field_key == req.field_key)
    ).scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"A product field with key {req.field_key!r} already exists.")
    count = db.execute(select(ProductFieldDefinition)).scalars().all()
    row = ProductFieldDefinition(
        field_key=req.field_key.strip(),
        label=req.label,
        field_type=req.field_type,
        required=req.required,
        sort_order=len(count),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_field_summary(row)


@admin_router.put("/agent/product-fields/{field_id}", response_model=ProductFieldSummary)
def update_product_field(field_id: int, req: ProductFieldPayload, db: Session = Depends(get_db)) -> ProductFieldSummary:
    row = db.get(ProductFieldDefinition, field_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Product field not found.")
    if req.field_type not in _PRODUCT_FIELD_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"{req.field_type!r} isn't a supported field_type — use one of {sorted(_PRODUCT_FIELD_TYPES)}.",
        )
    row.field_key = req.field_key.strip()
    row.label = req.label
    row.field_type = req.field_type
    row.required = req.required
    db.commit()
    db.refresh(row)
    return _to_field_summary(row)


@admin_router.delete("/agent/product-fields/{field_id}", status_code=204)
def delete_product_field(field_id: int, db: Session = Depends(get_db)) -> None:
    """Deleting a definition doesn't touch any Product.custom_fields
    values already stored under that key — same "historical data
    survives" posture as delete_intent_schema, just with no FK to
    enforce it (custom_fields is a plain JSONB blob, not a relation).
    A now-undefined key simply stops rendering with a label anywhere."""
    row = db.get(ProductFieldDefinition, field_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Product field not found.")
    db.delete(row)
    db.commit()


# --- Product relations (bundle/upsell, admin) ----------------------------


class ProductRelationPayload(BaseModel):
    related_product_id: int
    relation_type: str
    quantity: int | None = None


@admin_router.post("/agent/products/{product_id}/relations", response_model=RelationSummary)
def add_product_relation(product_id: int, req: ProductRelationPayload, db: Session = Depends(get_db)) -> RelationSummary:
    if req.relation_type not in _RELATION_TYPES:
        raise HTTPException(
            status_code=400, detail=f"relation_type must be one of {sorted(_RELATION_TYPES)}."
        )
    if req.related_product_id == product_id:
        raise HTTPException(status_code=400, detail="A product can't relate to itself.")
    product = db.get(Product, product_id)
    related = db.get(Product, req.related_product_id)
    if product is None or related is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    row = ProductRelation(
        product_id=product_id,
        related_product_id=req.related_product_id,
        relation_type=req.relation_type,
        quantity=req.quantity if req.relation_type == "bundle" else None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return RelationSummary(
        relation_id=row.id,
        product_id=related.id,
        name=related.name,
        price=float(related.price),
        image_url=related.image_url,
        quantity=row.quantity,
    )


@admin_router.delete("/agent/products/{product_id}/relations/{relation_id}", status_code=204)
def delete_product_relation(product_id: int, relation_id: int, db: Session = Depends(get_db)) -> None:
    row = db.get(ProductRelation, relation_id)
    if row is None or row.product_id != product_id:
        raise HTTPException(status_code=404, detail="Relation not found.")
    db.delete(row)
    db.commit()


# --- Product proposals (owner-agent drafts, never writes) -------------


class ProposedProduct(BaseModel):
    product: ProductPayload
    already_exists: bool
    existing_id: int | None


class ProposeProductsRequest(BaseModel):
    products: list[ProductPayload]


class ProposeProductsResponse(BaseModel):
    proposals: list[ProposedProduct]


@admin_router.post("/agent/products/propose", response_model=ProposeProductsResponse)
def propose_products(req: ProposeProductsRequest, db: Session = Depends(get_db)) -> ProposeProductsResponse:
    """Validates a batch of draft products exactly like create_product
    would, but never writes any of them — owner-agent's propose_products
    tool calls this so a product (and the price a real customer will be
    quoted) always goes through an explicit owner Apply/Discard in the
    dashboard (OwnerAgentPanel) instead of being written directly by the
    agent loop. See this module's docstring for why this tool proposes
    while set_order_status_options (a lower-stakes change) still applies
    directly."""
    if not req.products:
        raise HTTPException(status_code=400, detail="products must not be empty.")

    existing = db.execute(select(Product)).scalars().all()
    existing_by_name = {p.name.strip().lower(): p for p in existing}

    proposals: list[ProposedProduct] = []
    for draft in req.products:
        if not draft.name.strip():
            raise HTTPException(status_code=400, detail="Every product needs a non-empty name.")
        if draft.price < 0:
            raise HTTPException(status_code=400, detail=f"{draft.name!r} has a negative price.")
        match = existing_by_name.get(draft.name.strip().lower())
        proposals.append(
            ProposedProduct(product=draft, already_exists=match is not None, existing_id=match.id if match else None)
        )
    return ProposeProductsResponse(proposals=proposals)


# --- Order status options (owner-agent-set) ----------------------------


class OrderStatusOptionsPayload(BaseModel):
    status_options: list[str]


class OrderStatusOptionsResponse(BaseModel):
    status_options: list[str]


@admin_router.get("/agent/order-status-options", response_model=OrderStatusOptionsResponse)
def get_order_status_options(db: Session = Depends(get_db)) -> OrderStatusOptionsResponse:
    row = db.get(AppSettings, 1)
    options = row.order_status_options if row and row.order_status_options else DEFAULT_ORDER_STATUS_OPTIONS
    return OrderStatusOptionsResponse(status_options=options)


@admin_router.put("/agent/order-status-options", response_model=OrderStatusOptionsResponse)
def set_order_status_options(req: OrderStatusOptionsPayload, db: Session = Depends(get_db)) -> OrderStatusOptionsResponse:
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)
    row.order_status_options = req.status_options or DEFAULT_ORDER_STATUS_OPTIONS
    db.commit()
    return OrderStatusOptionsResponse(status_options=row.order_status_options)


# --- Shipping-allowed-regions (owner-agent-set, 2026-09-10) --------------
# Mirrors order_status_options above exactly — same "null/empty means no
# restriction" posture, same "no manual dashboard editor, owner-agent
# only" v1 scope. See checkout_cart's own docstring for how this is used.


class ShippingRegionsPayload(BaseModel):
    allowed_regions: list[str]


class ShippingRegionsResponse(BaseModel):
    allowed_regions: list[str]


@admin_router.get("/agent/shipping-settings", response_model=ShippingRegionsResponse)
def get_shipping_settings(db: Session = Depends(get_db)) -> ShippingRegionsResponse:
    row = db.get(AppSettings, 1)
    return ShippingRegionsResponse(allowed_regions=(row.shipping_allowed_regions if row else None) or [])


@admin_router.put("/agent/shipping-settings", response_model=ShippingRegionsResponse)
def set_shipping_settings(req: ShippingRegionsPayload, db: Session = Depends(get_db)) -> ShippingRegionsResponse:
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)
    # An empty list means "no restriction" — same as never having
    # configured it, not "block everything."
    row.shipping_allowed_regions = req.allowed_regions or None
    db.commit()
    return ShippingRegionsResponse(allowed_regions=row.shipping_allowed_regions or [])


# --- Order viewing/management (admin) ------------------------------------


class OrderItemSummary(BaseModel):
    id: int
    product_id: int | None
    item_name_snapshot: str
    unit_price_snapshot: float
    quantity: int
    subtotal: float
    comment: str | None
    served: bool


class OrderSummary(BaseModel):
    id: int
    contact_email: str | None
    contact_name: str | None
    status: str | None
    is_open: bool
    pickup_time: str | None
    note: str | None
    shipping_address: str | None
    shipping_region: str | None
    total_amount: float
    # Payment gate (2026-08-20, backend/payments.py) — see models.Order's
    # own docstring for why this is separate from `status` above.
    payment_status: str
    payment_provider: str | None
    items: list[OrderItemSummary]
    created_at: datetime


def _to_order_summary(row: Order) -> OrderSummary:
    return OrderSummary(
        id=row.id,
        contact_email=row.contact_email,
        contact_name=row.contact_name,
        status=row.status,
        is_open=row.is_open,
        pickup_time=row.pickup_time,
        note=row.note,
        shipping_address=row.shipping_address,
        shipping_region=row.shipping_region,
        total_amount=float(row.total_amount),
        payment_status=row.payment_status,
        payment_provider=row.payment_provider,
        items=[
            OrderItemSummary(
                id=i.id,
                product_id=i.product_id,
                item_name_snapshot=i.item_name_snapshot,
                unit_price_snapshot=float(i.unit_price_snapshot),
                quantity=i.quantity,
                subtotal=float(i.subtotal),
                comment=i.comment,
                served=i.served,
            )
            for i in row.items
        ],
        created_at=row.created_at,
    )


class OrderListResponse(BaseModel):
    items: list[OrderSummary]
    total: int


@admin_router.get("/agent/orders", response_model=OrderListResponse)
def list_orders(
    limit: int = 20,
    offset: int = 0,
    q: str | None = None,
    status: str | None = None,
    is_open: bool | None = None,
    db: Session = Depends(get_db),
) -> OrderListResponse:
    """Paginated + server-side filtered (2026-08-20, was a plain
    unbounded list with the same search/status/open filtering done
    client-side in `OrderPanel` — moved server-side specifically because
    client-side filtering only ever sees whatever page happened to be
    loaded, so a real search would silently miss an order that exists
    but isn't on the current page. `q` matches order id (cast to text),
    contact_name/email, pickup_time, note, OR any of the order's own
    item names — the same fields `OrderPanel`'s pre-pagination client
    filter checked, just run in SQL now."""
    filters = []
    if status is not None:
        filters.append(Order.status == status)
    if is_open is not None:
        filters.append(Order.is_open == is_open)
    if q and q.strip():
        q_like = f"%{q.strip()}%"
        item_match = select(OrderItem.order_id).where(OrderItem.item_name_snapshot.ilike(q_like))
        filters.append(
            or_(
                cast(Order.id, Text).ilike(q_like),
                Order.contact_name.ilike(q_like),
                Order.contact_email.ilike(q_like),
                Order.pickup_time.ilike(q_like),
                Order.note.ilike(q_like),
                Order.id.in_(item_match),
            )
        )

    total = db.execute(select(func.count()).select_from(Order).where(*filters)).scalar_one()
    rows = (
        db.execute(
            select(Order)
            .options(selectinload(Order.items))
            .where(*filters)
            .order_by(Order.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )
    return OrderListResponse(items=[_to_order_summary(r) for r in rows], total=total)


class UpdateOrderRequest(BaseModel):
    status: str | None = None
    is_open: bool | None = None
    # Refund (2026-09-10) — deliberately NOT a general payment_status
    # setter (which would let an admin claim "paid" for an order that was
    # never actually charged, undermining the whole "payment_status is a
    # trustworthy signal" design — see models.Order's own docstring). The
    # only manual transition this allows is a currently-"paid" order
    # becoming "refunded", recording that a refund already happened
    # through the owner's real payment processor (this app has no refund
    # PROCESSING of its own — see the class docstring below). A real,
    # previously-silent gap: this field used to not exist on this model
    # at all, so PATCHing `payment_status` here was silently dropped by
    # Pydantic (a misleading 200, no actual effect) — found and fixed
    # after a real e-commerce simulation caught it.
    mark_refunded: bool | None = None


@admin_router.patch("/agent/orders/{order_id}", response_model=OrderSummary)
async def update_order(order_id: int, req: UpdateOrderRequest, db: Session = Depends(get_db)) -> OrderSummary:
    """Partial update — only the fields the caller actually sent change.
    One endpoint for status/is_open/refund controls since OrderPanel
    adjusts them from the same row.

    `mark_refunded=True` records that the owner already refunded this
    order through their real payment processor's own dashboard (Stripe,
    ...) — this app has no refund-processing capability of its own, no
    API call to any payment provider happens here. Only valid on a
    currently-`"paid"` order; anything else 400s with a clear message
    rather than silently no-op'ing, which is exactly the trap the
    previous (nonexistent) version of this field fell into."""
    row = db.get(Order, order_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if req.status is not None:
        row.status = req.status
    if req.is_open is not None:
        row.is_open = req.is_open
    if req.mark_refunded:
        if row.payment_status != "paid":
            raise HTTPException(
                status_code=400,
                detail=f"Can't refund an order whose payment_status is '{row.payment_status}' — only a paid order can be marked refunded.",
            )
        row.payment_status = "refunded"
    db.commit()
    db.refresh(row)
    if req.mark_refunded:
        await notify_owner(
            db,
            f"[AI MVP] Order #{row.id} marked refunded",
            f"Order #{row.id} (${float(row.total_amount):.2f}) was marked refunded in the dashboard.",
        )
    return _to_order_summary(row)


class UpdateOrderItemRequest(BaseModel):
    served: bool | None = None
    comment: str | None = None


@admin_router.patch("/agent/order-items/{item_id}", response_model=OrderSummary)
def update_order_item(item_id: int, req: UpdateOrderItemRequest, db: Session = Depends(get_db)) -> OrderSummary:
    """Staff-side per-line kitchen controls (2026-08-20) — `served` is
    what OrderPanel's per-item toggle calls (own the ticket floor: which
    dishes are out, which are still coming); `comment` is here too so
    staff can correct a garbled customer note, not just read it. Neither
    is exposed to owner-agent — see OrderItem's own docstring for why
    this is a live kitchen action, not a cheap config value. Returns the
    whole parent OrderSummary (not just the one item) since OrderPanel
    already renders a full order at a time, same shape as update_order."""
    row = db.get(OrderItem, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Order item not found.")
    if req.served is not None:
        row.served = req.served
    if req.comment is not None:
        row.comment = req.comment.strip() or None
    db.commit()
    order = db.get(Order, row.order_id)
    db.refresh(order)
    return _to_order_summary(order)


# =========================================================================
# Public storefront surface (no auth) — apis/pages.py's public_router split
# =========================================================================


class PublicProductSummary(BaseModel):
    id: int
    name: str
    description: str | None
    price: float
    tags: list[str]
    image_url: str | None
    custom_fields: dict
    bundle_items: list[RelationSummary] = []
    upsells: list[RelationSummary] = []


def _to_public_summary(db: Session, row: Product) -> PublicProductSummary:
    return PublicProductSummary(
        id=row.id,
        name=row.name,
        description=row.description,
        price=float(row.price),
        tags=row.tags,
        image_url=row.image_url,
        custom_fields=row.custom_fields,
        bundle_items=_relations_for(db, row.id, "bundle"),
        upsells=_relations_for(db, row.id, "upsell"),
    )


@public_router.get("/product-fields", response_model=list[ProductFieldSummary])
def list_public_product_fields(db: Session = Depends(get_db)) -> list[ProductFieldSummary]:
    """Field LABELS aren't sensitive — a real storefront wants to show
    "Warranty: 2 years" to a customer, not just the raw custom_fields key.
    Same rows as the admin list_product_fields above, just reachable
    without a token — /products/[id]'s detail page renders
    Product.custom_fields against these labels, mirroring
    ReviewQueuePanel's own collected_fields-against-schema-fields
    rendering pattern."""
    rows = db.execute(select(ProductFieldDefinition).order_by(ProductFieldDefinition.sort_order)).scalars().all()
    return [_to_field_summary(r) for r in rows]


@public_router.get("/products", response_model=list[PublicProductSummary])
def list_public_products(
    tags: str | None = None, ids: str | None = None, db: Session = Depends(get_db)
) -> list[PublicProductSummary]:
    """What the ProductList Block fetches (client-side — see that
    component's own docstring for why) — available products only.

    `ids` (2026-08-20, comma-separated product ids) is an explicit
    allow-list — "feature exactly these products, in this order" (e.g. a
    homepage bestsellers strip) — and takes priority over `tags` when
    both are given; the two aren't meant to be combined. Results are
    reordered to match the given id order (SQL `IN` doesn't preserve it),
    so "id list = display order" holds. An id with no matching *available*
    product is silently dropped, not an error — same "degrade, don't
    break the page" posture as every other page-rendering read here.

    `tags` (comma-separated, replaced the old single `category` param
    2026-08-20 — see `models.Product`'s docstring) matches a product if
    ANY given tag appears as a substring of its own tags list (same
    cast-to-text `ILIKE` approach as `cart.search_products`, kept
    consistent rather than introducing a second, differently-behaved
    matching mechanism just for this one filter)."""
    if ids:
        try:
            id_list = [int(part) for part in ids.split(",") if part.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="ids must be a comma-separated list of integers.")
        if not id_list:
            return []
        rows = (
            db.execute(select(Product).where(Product.available.is_(True), Product.id.in_(id_list))).scalars().all()
        )
        by_id = {r.id: r for r in rows}
        ordered = [by_id[i] for i in id_list if i in by_id]
        return [_to_public_summary(db, r) for r in ordered]

    stmt = select(Product).where(Product.available.is_(True))
    if tags:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        if tag_list:
            tag_conditions = [cast(Product.tags, Text).ilike(f"%{t}%") for t in tag_list]
            combined = tag_conditions[0]
            for cond in tag_conditions[1:]:
                combined = combined | cond
            stmt = stmt.where(combined)
    rows = db.execute(stmt.order_by(Product.created_at.desc())).scalars().all()
    return [_to_public_summary(db, r) for r in rows]


class ProductSearchResponse(BaseModel):
    products: list[PublicProductSummary]
    # Added 2026-08-20 for /search's own pagination — total match count
    # ignoring limit/offset, from cart.count_search_products (shares its
    # filter condition with search_products so the two can't disagree).
    total: int = 0


# Registered BEFORE /products/{product_id} — FastAPI matches routes in
# registration order, and a fixed literal path like "/products/search"
# must be checked before the dynamic "/products/{product_id}" pattern
# or a request to /products/search gets swallowed as product_id="search"
# (a real bug caught here: it 422'd with "search" isn't a valid int).
@public_router.get("/products/search", response_model=ProductSearchResponse)
def search_products_endpoint(
    q: str, limit: int = 20, offset: int = 0, db: Session = Depends(get_db)
) -> ProductSearchResponse:
    """Wraps cart.search_products directly — what /search and the chat
    pipeline's own search path both ultimately reuse, so a visitor gets
    the identical result set whether they browse the page or ask in chat.
    `offset`/`total` (2026-08-20) close a real known gap: this used to
    hard-cap at `limit` with no "showing X of N" signal at all — a query
    matching more than `limit` products silently dropped the rest with
    no indication anything was cut off (see the root AGENTS.md)."""
    rows = search_products(db, q, limit=limit, offset=offset)
    total = count_search_products(db, q)
    return ProductSearchResponse(products=[_to_public_summary(db, r) for r in rows], total=total)


@public_router.get("/products/{product_id}", response_model=PublicProductSummary)
def get_public_product(product_id: int, db: Session = Depends(get_db)) -> PublicProductSummary:
    """What /products/[id] fetches — 404 for a missing OR unavailable
    product, same posture as GET /pages/{slug}'s 404-on-nothing-saved."""
    row = db.get(Product, product_id)
    if row is None or not row.available:
        raise HTTPException(status_code=404, detail="Product not found.")
    return _to_public_summary(db, row)


class CartAddRequest(BaseModel):
    session_id: str
    product_id: int
    quantity: int = 1
    # A per-line customization note ("less sugar", "extra spicy") — see
    # cart.apply_order_delta's docstring for why this is part of what
    # identifies a distinct line, not just product_id.
    comment: str | None = None


class CartAddResponse(BaseModel):
    order_id: int
    total_amount: float


@public_router.post("/cart/add", response_model=CartAddResponse)
def add_to_cart(req: CartAddRequest, db: Session = Depends(get_db)) -> CartAddResponse:
    """The deterministic, non-LLM add-to-cart mutation — reuses the exact
    same chat_session_id identity as /api/chat (via _get_or_create_session)
    so a visitor's cart never splits between "things clicked on a page"
    and "things said in chat," and cart.apply_order_delta, the same
    function apis/chat.py's LLM path calls, so there's one order-mutation
    code path, not two divergent ones."""
    if req.quantity <= 0:
        raise HTTPException(status_code=400, detail="quantity must be positive.")
    product = db.get(Product, req.product_id)
    if product is None or not product.available:
        raise HTTPException(status_code=404, detail="Product not found.")

    session = _get_or_create_session(db, req.session_id, None)
    order = find_active_order(db, session.id)
    if order is None:
        order = Order(chat_session_id=session.id, is_open=True)
        db.add(order)
        db.flush()  # populates order.id before apply_order_delta's OrderItem rows reference it

    apply_order_delta(db, order, product, req.quantity, comment=req.comment)
    db.commit()
    db.refresh(order)
    return CartAddResponse(order_id=order.id, total_amount=float(order.total_amount))


@public_router.get("/cart", response_model=OrderSummary | None)
def get_cart(session_id: str, db: Session = Depends(get_db)) -> OrderSummary | None:
    """What the /cart and /checkout pages read (2026-08-20) — the same
    session-scoped active order every other cart surface resolves via
    find_active_order, so a visitor's cart page always shows exactly what
    chat/the product pages already built up. `None` (not a 404) for "no
    cart yet" — an empty cart is a normal state for a first-time visitor,
    not an error."""
    session = _get_or_create_session(db, session_id, None)
    order = find_active_order(db, session.id)
    return _to_order_summary(order) if order else None


class CartUpdateRequest(BaseModel):
    session_id: str
    # Targets the specific OrderItem row (2026-08-20, was product_id) —
    # a product can now have more than one line in the same cart when
    # lines carry different comments (see cart.apply_order_delta's
    # docstring), so product_id alone can no longer say which line the
    # visitor's +/-/Remove control meant.
    item_id: int
    # Unlike CartAddRequest.quantity (always positive, "add this many"),
    # this can be negative — the /cart page's quantity stepper and Remove
    # button both resolve to this one endpoint. Remove is just a delta
    # equal to -(current quantity), computed client-side from what
    # GET /cart already returned.
    quantity_delta: int


@public_router.post("/cart/update", response_model=CartAddResponse)
def update_cart_item(req: CartUpdateRequest, db: Session = Depends(get_db)) -> CartAddResponse:
    """Decrementing/removing an item already in the cart is always
    allowed even if the product has since become unavailable (a visitor
    must always be able to take something OUT of their cart); only a
    positive delta (adding more) is blocked for an unavailable/missing
    product, mirroring add_to_cart's own check. Ownership is implicit —
    the item must belong to this session's own active order, never just
    any item_id.

    **The one exception: an already-`served` line is fully locked**
    (2026-08-20, real bug fix) — once the kitchen marks a line served
    (`OrderPanel`), a visitor can no longer change its quantity or
    remove it at all, not even a decrease. Before this fix, a visitor
    could delete a dish after it was already delivered (free food) or
    silently change what the final bill reflects versus what was
    actually served (a dispute waiting to happen). Ordering more of the
    same product after its line is served opens a new, separate,
    unserved line instead — see cart.apply_order_delta's docstring."""
    if req.quantity_delta == 0:
        raise HTTPException(status_code=400, detail="quantity_delta must not be zero.")

    session = _get_or_create_session(db, req.session_id, None)
    order = find_active_order(db, session.id)
    item = next((i for i in order.items if i.id == req.item_id), None) if order else None
    if item is None:
        raise HTTPException(status_code=404, detail="Cart item not found.")
    if item.served:
        raise HTTPException(
            status_code=400, detail="This item has already been served and can no longer be changed."
        )
    if req.quantity_delta > 0:
        product = db.get(Product, item.product_id) if item.product_id is not None else None
        if product is None or not product.available:
            raise HTTPException(status_code=404, detail="Product not found.")

    new_quantity = item.quantity + req.quantity_delta
    if new_quantity <= 0:
        order.items.remove(item)
    else:
        item.quantity = new_quantity
        item.subtotal = float(item.unit_price_snapshot) * new_quantity
    order.total_amount = sum((float(i.subtotal) for i in order.items), 0.0)

    db.commit()
    db.refresh(order)
    return CartAddResponse(order_id=order.id, total_amount=float(order.total_amount))


class CartItemCommentRequest(BaseModel):
    session_id: str
    comment: str | None = None


@public_router.post("/cart/item/{item_id}/comment", response_model=CartAddResponse)
def update_cart_item_comment(
    item_id: int, req: CartItemCommentRequest, db: Session = Depends(get_db)
) -> CartAddResponse:
    """Lets a visitor attach, edit, or clear a per-line customization
    note ("less sugar", "extra spicy") on an item already in their cart
    (2026-08-20) — separate from /cart/update since a comment edit isn't
    a quantity change. `comment: null`/empty clears it. Ownership scoped
    to this session's own active order, same as update_cart_item."""
    session = _get_or_create_session(db, req.session_id, None)
    order = find_active_order(db, session.id)
    item = next((i for i in order.items if i.id == item_id), None) if order else None
    if item is None:
        raise HTTPException(status_code=404, detail="Cart item not found.")
    if item.served:
        raise HTTPException(
            status_code=400, detail="This item has already been served and can no longer be changed."
        )
    item.comment = (req.comment or "").strip() or None
    db.commit()
    db.refresh(order)
    return CartAddResponse(order_id=order.id, total_amount=float(order.total_amount))


class CheckoutRequest(BaseModel):
    session_id: str
    contact_email: str | None = None
    contact_name: str | None = None
    pickup_time: str | None = None
    note: str | None = None
    # Shipping (2026-09-10) — both optional; a dine-in/pickup checkout
    # simply never sends them, and shipping_region only ever gates
    # checkout when the owner has actually configured
    # AppSettings.shipping_allowed_regions (see checkout_cart below).
    shipping_address: str | None = None
    shipping_region: str | None = None


class CheckoutResponse(BaseModel):
    order: OrderSummary
    # Set only when the configured payment provider needs the visitor to
    # actually pay through a real UI (Stripe's embedded Checkout, see
    # backend/payments.py) — null when payment already resolved
    # synchronously (the "test" provider). The frontend mounts Stripe's
    # own `<EmbeddedCheckout>` modal with this when set (2026-09-10 — a
    # popup on this page, not a full-page redirect, see payments.py's own
    # docstring for the "why"), shows the normal confirmation screen when
    # not.
    client_secret: str | None


@public_router.post("/cart/checkout", response_model=CheckoutResponse)
async def checkout_cart(req: CheckoutRequest, db: Session = Depends(get_db)) -> CheckoutResponse:
    """Finalizes the visitor's own active cart through the owner's
    configured payment gate (backend/payments.py) — "test" (the default)
    skips straight to a paid, closed order with no real charge; "stripe"
    creates a real embedded Checkout Session and hands back its
    `client_secret` instead of closing the order immediately. The order
    only actually closes (`is_open = False`) once payment is confirmed —
    synchronously here for "test," asynchronously via
    `POST /webhooks/stripe` for a real Stripe payment, since a visitor
    can close the tab right after paying and before the embedded
    checkout's own return trip completes. 400s on an empty/missing cart
    rather than creating an empty Order — nothing to check out.

    **Shipping-region gate (2026-09-10)** — deterministic Python, no
    third-party geocoding: if the owner has configured
    `AppSettings.shipping_allowed_regions` (a plain owner-typed list, see
    `set_shipping_allowed_regions`) AND this checkout states a
    `shipping_region`, the region is matched case-insensitively against
    that list before any payment is even attempted. Checked BEFORE
    mutating the order, so a rejected checkout never partially persists
    contact/shipping fields. A checkout with no `shipping_region` at all
    (every dine-in/pickup order, and any e-commerce order placed before
    this field existed) is unaffected regardless of configuration —
    this only ever gates an order that actually states a region."""
    session = _get_or_create_session(db, req.session_id, None)
    order = find_active_order(db, session.id)
    if order is None or not order.items:
        raise HTTPException(status_code=400, detail="Your cart is empty — nothing to check out.")

    effective_region = req.shipping_region if req.shipping_region is not None else order.shipping_region
    if effective_region and effective_region.strip():
        settings_row = db.get(AppSettings, 1)
        allowed = settings_row.shipping_allowed_regions if settings_row else None
        if allowed and effective_region.strip().lower() not in [r.strip().lower() for r in allowed]:
            await notify_owner(
                db,
                f"[AI MVP] Order #{order.id} blocked — unsupported shipping region",
                f"A visitor tried to check out order #{order.id} (${float(order.total_amount):.2f}) "
                f"to '{effective_region.strip()}', which isn't on the configured shipping-allowed-regions "
                f"list. Checkout was blocked — the cart is still open if they want to try a different region.",
            )
            raise HTTPException(
                status_code=400,
                detail=f"Sorry, we don't currently ship to '{effective_region.strip()}'.",
            )

    if req.contact_email is not None:
        order.contact_email = req.contact_email.strip() or None
    if req.contact_name is not None:
        order.contact_name = req.contact_name.strip() or None
    if req.pickup_time is not None:
        order.pickup_time = req.pickup_time.strip() or None
    if req.note is not None:
        order.note = req.note.strip() or None
    if req.shipping_address is not None:
        order.shipping_address = req.shipping_address.strip() or None
    if req.shipping_region is not None:
        order.shipping_region = req.shipping_region.strip() or None
    db.commit()
    db.refresh(order)

    try:
        provider_name, provider = resolve_payment_provider(db)
    except PaymentProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))

    # {CHECKOUT_SESSION_ID} is a literal template Stripe itself
    # substitutes on redirect — not an f-string placeholder, must not be
    # escaped/formatted away. Embedded mode uses a single return_url
    # (unlike hosted mode's separate success_url/cancel_url) since a
    # visitor never fully leaves this page either way.
    return_url = f"{FRONTEND_PUBLIC_URL}/checkout/complete?order_id={order.id}&session_id={{CHECKOUT_SESSION_ID}}"
    try:
        result = await provider.create_checkout(order, return_url)
    except PaymentProviderNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))

    order.payment_provider = provider_name
    if result.already_paid:
        order.payment_status = "paid"
        order.is_open = False
    db.commit()
    db.refresh(order)

    if result.already_paid:
        # A real Stripe order isn't "placed" yet at this point — payment
        # hasn't happened, just a Checkout Session was created — so that
        # notification belongs on the webhook's own paid branch instead
        # (apis/payments.py's stripe_webhook), not here.
        await notify_owner(
            db,
            f"[AI MVP] New order #{order.id} — ${float(order.total_amount):.2f}",
            f"Order #{order.id} was placed and paid ({provider_name}).\n\n"
            + "\n".join(f"{i.quantity}x {i.item_name_snapshot}" for i in order.items)
            + f"\n\nTotal: ${float(order.total_amount):.2f}"
            + (f"\nContact: {order.contact_email}" if order.contact_email else "")
            + (f"\nPickup/delivery: {order.pickup_time}" if order.pickup_time else "")
            + (f"\nShip to: {order.shipping_address}" if order.shipping_address else ""),
        )

    return CheckoutResponse(order=_to_order_summary(order), client_secret=result.client_secret)
