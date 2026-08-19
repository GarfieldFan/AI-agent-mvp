"""Shared Product/Order search + mutation logic (2026-08-19) — used both by
apis/chat.py's LLM-driven order capture and apis/products.py's direct,
deterministic `POST /cart/add` endpoint, so a visitor's cart accumulates
the same way whether they type in the chatbot or click a button on a page.

Deliberately a plain top-level module, not living inside either router —
apis/chat.py needs these functions, apis/products.py needs these functions,
and apis/products.py separately needs apis/chat.py's `_get_or_create_session`
(to resolve a client session_id into a real ChatSession row) — putting this
logic inside either router file would make the two import each other,
a circular import. Mirrors chat_attachments.py's existing precedent for
cross-router shared logic living in a plain top-level module.

`search_products` is the ONE place any caller (chat pipeline, the public
search endpoint, cart-add) resolves a plain-language phrase into real
Product rows — deterministic SQL (`ILIKE`), never an LLM guessing a
product_id out of a catalog listed in its own prompt. See the root
AGENTS.md for the full "why" behind this refactor of what was originally
built directly inside apis/chat.py.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from models import Order, OrderItem, Product


def search_products(db: Session, query: str, limit: int = 20) -> list[Product]:
    """ILIKE across name/description/category, available=True only. Not a
    search engine — good enough for a catalog this app's scale is meant
    for; a real vector/full-text upgrade path exists (mirrors RAG's own
    document search) but isn't built here, see the root AGENTS.md.

    **Tokenized, not one whole-phrase substring match** — found and fixed
    from a real extraction-call output: the LLM extracted "coffee drinks"
    for "what coffee drinks do you have," but no product's text contains
    that exact phrase (only "coffee drink," singular) — a single
    `ILIKE '%coffee drinks%'` matched nothing at all despite 6 real coffee
    products existing. Splitting the query into words and matching if ANY
    word (2+ chars, skips "a"/"an"/etc.) appears is far more forgiving of
    the LLM's exact phrasing not lining up with a product's exact text."""
    words = [w for w in query.strip().split() if len(w) >= 2]
    if not words:
        return []
    word_conditions = [
        Product.name.ilike(f"%{w}%") | Product.description.ilike(f"%{w}%") | Product.category.ilike(f"%{w}%")
        for w in words
    ]
    combined = word_conditions[0]
    for cond in word_conditions[1:]:
        combined = combined | cond
    name_match_any = Product.name.ilike(f"%{words[0]}%")
    for w in words[1:]:
        name_match_any = name_match_any | Product.name.ilike(f"%{w}%")
    rows = (
        db.execute(
            select(Product)
            .where(Product.available.is_(True), combined)
            # A name match on any word ranks first, then most recent —
            # simple, no new search-relevance machinery.
            .order_by(name_match_any.desc(), Product.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return list(rows)


def find_active_order(db: Session, chat_session_id: int | None) -> Order | None:
    """The most recent OPEN Order for this chat session, if any — what
    makes "add one more latte" (or a page's Add to cart button) append
    to the same order instead of starting a new one. Gated on `is_open`,
    deliberately NOT on `status` (a free-text label owner-agent can set
    to anything) — see models.py's Order docstring."""
    if chat_session_id is None:
        return None
    return db.execute(
        select(Order)
        .options(selectinload(Order.items))
        .where(Order.chat_session_id == chat_session_id, Order.is_open.is_(True))
        .order_by(Order.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def apply_order_delta(db: Session, order: Order, product: Product, quantity_delta: int) -> None:
    """Applies one quantity delta to `order` for `product` — creates,
    updates, or removes the matching OrderItem (clamped at 0), then
    recomputes `order.total_amount` from real line items. Never trusts a
    caller-supplied total. Assumes `order.id` is already populated
    (flushed) if `order` is newly created — never commits itself, the
    caller manages its own transaction (apis/chat.py applies several
    deltas per turn in one commit; cart-add commits once per call)."""
    existing_item = next((i for i in order.items if i.product_id == product.id), None)
    if existing_item is None:
        if quantity_delta <= 0:
            return  # nothing to remove from an order that never had it
        order.items.append(
            OrderItem(
                order_id=order.id,
                product_id=product.id,
                item_name_snapshot=product.name,
                unit_price_snapshot=float(product.price),
                quantity=quantity_delta,
                subtotal=float(product.price) * quantity_delta,
            )
        )
    else:
        new_quantity = existing_item.quantity + quantity_delta
        if new_quantity <= 0:
            order.items.remove(existing_item)
        else:
            existing_item.quantity = new_quantity
            existing_item.subtotal = float(existing_item.unit_price_snapshot) * new_quantity

    order.total_amount = sum((float(i.subtotal) for i in order.items), 0.0)
