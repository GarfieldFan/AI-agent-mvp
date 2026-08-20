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

from sqlalchemy import Text, cast, func, select
from sqlalchemy.orm import Session, selectinload

from models import Order, OrderItem, Product


def _search_condition(query: str):
    """Builds the tokenized ILIKE condition search_products/
    count_search_products both filter on — factored out (2026-08-20) so
    the count query and the row query can never silently drift apart.
    Returns `None` when there are no usable words (caller decides what
    "no query" means for its own case)."""
    words = [w for w in query.strip().split() if len(w) >= 2]
    if not words:
        return None
    word_conditions = [
        Product.name.ilike(f"%{w}%")
        | Product.description.ilike(f"%{w}%")
        | cast(Product.tags, Text).ilike(f"%{w}%")
        for w in words
    ]
    combined = word_conditions[0]
    for cond in word_conditions[1:]:
        combined = combined | cond
    return combined


def count_search_products(db: Session, query: str) -> int:
    """Total available-product match count for `query`, ignoring
    limit/offset — powers `/search`'s pagination (2026-08-20, "showing X
    of N" and page count), which `search_products`'s own `limit` alone
    can't answer. Shares `_search_condition` with `search_products` so
    the two can never disagree on what counts as a match."""
    condition = _search_condition(query)
    if condition is None:
        return 0
    return db.execute(
        select(func.count()).select_from(Product).where(Product.available.is_(True), condition)
    ).scalar_one()


def search_products(db: Session, query: str, limit: int = 20, offset: int = 0) -> list[Product]:
    """ILIKE across name/description/tags, available=True only. Not a
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
    the LLM's exact phrasing not lining up with a product's exact text.

    **`tags` (2026-08-20, replaced the old single `category` string —
    see `models.Product`'s docstring) is matched by casting the JSONB
    array to text and `ILIKE`-ing that**, not a real per-element JSONB
    query — deliberately the simplest thing that works at this scale,
    matching this function's own "not a search engine" posture. This is
    also what makes tags able to fix cross-lingual matching at all: a
    product tagged `["Coffee", "咖啡"]` now matches a visitor searching
    either "coffee" or "咖啡", since the word just needs to appear
    *somewhere* in the tag list's text form — no per-tag exact-match
    requirement.

    **`offset` (2026-08-20)** — added for `/search`'s pagination; the
    chat pipeline's own callers never pass it (they only ever want the
    top few matches), so it defaults to 0 and is a no-op for them."""
    condition = _search_condition(query)
    if condition is None:
        return []
    words = [w for w in query.strip().split() if len(w) >= 2]
    name_match_any = Product.name.ilike(f"%{words[0]}%")
    for w in words[1:]:
        name_match_any = name_match_any | Product.name.ilike(f"%{w}%")
    rows = (
        db.execute(
            select(Product)
            .where(Product.available.is_(True), condition)
            # A name match on any word ranks first, then most recent —
            # simple, no new search-relevance machinery.
            .order_by(name_match_any.desc(), Product.created_at.desc())
            .limit(limit)
            .offset(offset)
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


def apply_order_delta(
    db: Session, order: Order, product: Product, quantity_delta: int, comment: str | None = None
) -> None:
    """Applies one quantity delta to `order` for `product` — creates,
    updates, or removes the matching OrderItem (clamped at 0), then
    recomputes `order.total_amount` from real line items. Never trusts a
    caller-supplied total. Assumes `order.id` is already populated
    (flushed) if `order` is newly created — never commits itself, the
    caller manages its own transaction (apis/chat.py applies several
    deltas per turn in one commit; cart-add commits once per call).

    **Matches an existing line to merge into by `(product_id, comment)`,
    not `product_id` alone** (2026-08-20, see OrderItem's own docstring)
    — two lattes with different customizations ("less sugar" vs plain)
    are two distinct line items, never silently merged into quantity=2.
    `comment` is normalized (blank string treated as `None`) so "no
    comment" reliably merges with any other "no comment" line for the
    same product, matching this function's pre-comment behavior exactly
    when `comment` is never passed.

    **Never matches an already-`served` line** (2026-08-20 — a real bug
    fix: a visitor could otherwise remove or silently inflate the
    quantity on a dish the kitchen already sent out, which is both a
    "free food" hole and a receipt/dispute problem). A positive delta
    against a product whose only existing line is served opens a
    **new**, unserved line instead of bumping the served one (a second
    round of the same item is a distinct kitchen ticket anyway). A
    negative delta finds no matching (unserved) line and correctly
    no-ops via the `existing_item is None` branch below — there is
    nothing left for a visitor to remove once the only line is served.
    Direct edits to an already-served line (`/cart/update`,
    `/cart/item/{id}/comment`) are blocked at the route level instead,
    since those act on a specific `item_id` this function never sees."""
    normalized_comment = comment.strip() if comment and comment.strip() else None
    existing_item = next(
        (
            i
            for i in order.items
            if i.product_id == product.id and (i.comment or None) == normalized_comment and not i.served
        ),
        None,
    )
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
                comment=normalized_comment,
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
