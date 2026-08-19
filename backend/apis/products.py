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

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from apis.chat import _get_or_create_session
from apis.deps import Role, require_role
from cart import apply_order_delta, find_active_order, search_products
from db import get_db
from models import AppSettings, Order, Product, ProductFieldDefinition, ProductRelation

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
    category: str | None = None
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
        category=row.category,
        available=row.available,
        image_url=row.image_url,
        custom_fields=row.custom_fields,
        created_at=row.created_at,
        bundle_items=_relations_for(db, row.id, "bundle"),
        upsells=_relations_for(db, row.id, "upsell"),
    )


@admin_router.get("/agent/products", response_model=list[ProductSummary])
def list_products(db: Session = Depends(get_db)) -> list[ProductSummary]:
    rows = db.execute(select(Product).order_by(Product.created_at.desc())).scalars().all()
    return [_to_product_summary(db, r) for r in rows]


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
        category=req.category,
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
    row.category = req.category
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


# --- Order viewing/management (admin) ------------------------------------


class OrderItemSummary(BaseModel):
    id: int
    product_id: int | None
    item_name_snapshot: str
    unit_price_snapshot: float
    quantity: int
    subtotal: float


class OrderSummary(BaseModel):
    id: int
    contact_email: str | None
    contact_name: str | None
    status: str | None
    is_open: bool
    pickup_time: str | None
    note: str | None
    total_amount: float
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
        total_amount=float(row.total_amount),
        items=[
            OrderItemSummary(
                id=i.id,
                product_id=i.product_id,
                item_name_snapshot=i.item_name_snapshot,
                unit_price_snapshot=float(i.unit_price_snapshot),
                quantity=i.quantity,
                subtotal=float(i.subtotal),
            )
            for i in row.items
        ],
        created_at=row.created_at,
    )


@admin_router.get("/agent/orders", response_model=list[OrderSummary])
def list_orders(db: Session = Depends(get_db)) -> list[OrderSummary]:
    rows = (
        db.execute(select(Order).options(selectinload(Order.items)).order_by(Order.created_at.desc()))
        .scalars()
        .all()
    )
    return [_to_order_summary(r) for r in rows]


class UpdateOrderRequest(BaseModel):
    status: str | None = None
    is_open: bool | None = None


@admin_router.patch("/agent/orders/{order_id}", response_model=OrderSummary)
def update_order(order_id: int, req: UpdateOrderRequest, db: Session = Depends(get_db)) -> OrderSummary:
    """Partial update — only the fields the caller actually sent change.
    One endpoint for both controls (status label + is_open) since
    OrderPanel adjusts them from the same row."""
    row = db.get(Order, order_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if req.status is not None:
        row.status = req.status
    if req.is_open is not None:
        row.is_open = req.is_open
    db.commit()
    db.refresh(row)
    return _to_order_summary(row)


# =========================================================================
# Public storefront surface (no auth) — apis/pages.py's public_router split
# =========================================================================


class PublicProductSummary(BaseModel):
    id: int
    name: str
    description: str | None
    price: float
    category: str | None
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
        category=row.category,
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
    category: str | None = None, ids: str | None = None, db: Session = Depends(get_db)
) -> list[PublicProductSummary]:
    """What the ProductList Block fetches (client-side — see that
    component's own docstring for why) — available products only.

    `ids` (2026-08-20, comma-separated product ids) is an explicit
    allow-list — "feature exactly these products, in this order" (e.g. a
    homepage bestsellers strip) — and takes priority over `category` when
    both are given; the two aren't meant to be combined. Results are
    reordered to match the given id order (SQL `IN` doesn't preserve it),
    so "id list = display order" holds. An id with no matching *available*
    product is silently dropped, not an error — same "degrade, don't
    break the page" posture as every other page-rendering read here."""
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
    if category:
        stmt = stmt.where(Product.category == category)
    rows = db.execute(stmt.order_by(Product.created_at.desc())).scalars().all()
    return [_to_public_summary(db, r) for r in rows]


class ProductSearchResponse(BaseModel):
    products: list[PublicProductSummary]


# Registered BEFORE /products/{product_id} — FastAPI matches routes in
# registration order, and a fixed literal path like "/products/search"
# must be checked before the dynamic "/products/{product_id}" pattern
# or a request to /products/search gets swallowed as product_id="search"
# (a real bug caught here: it 422'd with "search" isn't a valid int).
@public_router.get("/products/search", response_model=ProductSearchResponse)
def search_products_endpoint(q: str, limit: int = 20, db: Session = Depends(get_db)) -> ProductSearchResponse:
    """Wraps cart.search_products directly — what /search and the chat
    pipeline's own search path both ultimately reuse, so a visitor gets
    the identical result set whether they browse the page or ask in chat."""
    rows = search_products(db, q, limit=limit)
    return ProductSearchResponse(products=[_to_public_summary(db, r) for r in rows])


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

    apply_order_delta(db, order, product, req.quantity)
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
    product_id: int
    # Unlike CartAddRequest.quantity (always positive, "add this many"),
    # this can be negative — the /cart page's quantity stepper and Remove
    # button both resolve to this one endpoint, reusing apply_order_delta
    # exactly like every other cart mutation in this app (never a second,
    # divergent mutation path).
    quantity_delta: int


@public_router.post("/cart/update", response_model=CartAddResponse)
def update_cart_item(req: CartUpdateRequest, db: Session = Depends(get_db)) -> CartAddResponse:
    """The /cart page's quantity +/- and Remove controls — Remove is just
    a delta equal to -(current quantity), computed client-side from what
    GET /cart already returned. Decrementing/removing an item already in
    the cart is always allowed even if the product has since become
    unavailable (a visitor must always be able to take something OUT of
    their cart); only a positive delta (adding more) is blocked for an
    unavailable/missing product, mirroring add_to_cart's own check."""
    if req.quantity_delta == 0:
        raise HTTPException(status_code=400, detail="quantity_delta must not be zero.")
    product = db.get(Product, req.product_id)
    if product is None or (req.quantity_delta > 0 and not product.available):
        raise HTTPException(status_code=404, detail="Product not found.")

    session = _get_or_create_session(db, req.session_id, None)
    order = find_active_order(db, session.id)
    if order is None:
        if req.quantity_delta <= 0:
            raise HTTPException(status_code=404, detail="No active cart to update.")
        order = Order(chat_session_id=session.id, is_open=True)
        db.add(order)
        db.flush()  # populates order.id before apply_order_delta's OrderItem rows reference it

    apply_order_delta(db, order, product, req.quantity_delta)
    db.commit()
    db.refresh(order)
    return CartAddResponse(order_id=order.id, total_amount=float(order.total_amount))


class CheckoutRequest(BaseModel):
    session_id: str
    contact_email: str | None = None
    contact_name: str | None = None
    pickup_time: str | None = None
    note: str | None = None


@public_router.post("/cart/checkout", response_model=OrderSummary)
def checkout_cart(req: CheckoutRequest, db: Session = Depends(get_db)) -> OrderSummary:
    """Finalizes the visitor's own active cart — no real payment anywhere
    in this app (see models.py's Order docstring), so "checking out" means
    recording the contact/pickup details and flipping `is_open` to False,
    the same signal the owner's own dashboard (OrderPanel) already uses
    for "no more chat/cart add-ons to this order," reused here for "the
    visitor themselves is done adding to it." 400s on an empty/missing
    cart rather than creating an empty Order — nothing to check out."""
    session = _get_or_create_session(db, req.session_id, None)
    order = find_active_order(db, session.id)
    if order is None or not order.items:
        raise HTTPException(status_code=400, detail="Your cart is empty — nothing to check out.")

    if req.contact_email is not None:
        order.contact_email = req.contact_email.strip() or None
    if req.contact_name is not None:
        order.contact_name = req.contact_name.strip() or None
    if req.pickup_time is not None:
        order.pickup_time = req.pickup_time.strip() or None
    if req.note is not None:
        order.note = req.note.strip() or None
    order.is_open = False

    db.commit()
    db.refresh(order)
    return _to_order_summary(order)
