"""PDF order-receipt generation (2026-09-21) — a pure function turning an
already-loaded `Order` (+ the owner's business-profile fields, if any)
into receipt PDF bytes. Deliberately a separate top-level module, not
folded into `apis/products.py` — this is document-formatting logic, not
a route handler, and three different routes (admin/owner, a logged-in
customer's own `/my/orders`, and a public session-scoped download) all
need the identical output, so it has to live somewhere none of them
import from each other.

Uses `reportlab` (see requirements.txt's own comment for why, over e.g.
weasyprint) — a simple, table-based document, not a page-layout engine.
No business logo image is embedded in v1 (text-only) — a real, deliberate
scope cut, not an oversight: embedding an already-uploaded media file
would mean this module also needs to resolve/fetch that file from disk,
a second concern this function doesn't need to take on for a first cut.

Money is always formatted from `Decimal`/`float` values already stored
on the Order/OrderItem rows — this module never computes a total itself,
it only renders `Order.total_amount`/`OrderItem.subtotal`, the same
"never trust computed-here arithmetic for money" posture the rest of
this app already holds (see cart.py's own docstring)."""

from __future__ import annotations

import io
from typing import TYPE_CHECKING

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet

if TYPE_CHECKING:
    from models import AppSettings, Order


def _business_address_lines(business: "AppSettings | None") -> list[str]:
    if business is None:
        return []
    lines: list[str] = []
    if business.business_street_address:
        lines.append(business.business_street_address)
    city_region_postal = ", ".join(
        part
        for part in (business.business_locality, business.business_region, business.business_postal_code)
        if part
    )
    if city_region_postal:
        lines.append(city_region_postal)
    if business.business_country:
        lines.append(business.business_country)
    if business.business_phone:
        lines.append(f"Phone: {business.business_phone}")
    if business.business_email:
        lines.append(f"Email: {business.business_email}")
    return lines


def build_order_receipt_pdf(order: "Order", business: "AppSettings | None") -> bytes:
    """Renders `order` (with its `items` relationship already loaded) as
    a one-page PDF receipt. Never raises on missing optional fields —
    every business-profile/contact/shipping field is genuinely optional
    throughout this app, and a receipt with some blank sections is still
    a useful receipt."""
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
    )
    styles = getSampleStyleSheet()
    story = []

    business_name = (business.business_name if business else None) or "Receipt"
    story.append(Paragraph(business_name, styles["Title"]))
    for line in _business_address_lines(business):
        story.append(Paragraph(line, styles["Normal"]))
    story.append(Spacer(1, 0.25 * inch))

    story.append(Paragraph(f"Receipt — Order #{order.id}", styles["Heading2"]))
    story.append(Paragraph(f"Date: {order.created_at.strftime('%Y-%m-%d %H:%M')}", styles["Normal"]))
    story.append(
        Paragraph(f"Payment status: {order.payment_status}" + (f" ({order.payment_provider})" if order.payment_provider else ""), styles["Normal"])
    )
    if order.payment_reference:
        story.append(Paragraph(f"Payment reference: {order.payment_reference}", styles["Normal"]))
    story.append(Spacer(1, 0.2 * inch))

    contact_lines = []
    if order.contact_name:
        contact_lines.append(order.contact_name)
    if order.contact_email:
        contact_lines.append(order.contact_email)
    if order.pickup_time:
        contact_lines.append(f"Pickup/delivery: {order.pickup_time}")
    if order.shipping_address:
        contact_lines.append(f"Ship to: {order.shipping_address}")
    if order.shipping_region:
        contact_lines.append(f"Region: {order.shipping_region}")
    if order.note:
        contact_lines.append(f"Note: {order.note}")
    if contact_lines:
        story.append(Paragraph("Billed to", styles["Heading3"]))
        for line in contact_lines:
            story.append(Paragraph(line, styles["Normal"]))
        story.append(Spacer(1, 0.2 * inch))

    table_data = [["Item", "Qty", "Unit price", "Subtotal"]]
    for item in order.items:
        name = item.item_name_snapshot + (f" ({item.comment})" if item.comment else "")
        unit_price = float(item.unit_price_snapshot)
        table_data.append([name, str(item.quantity), f"${unit_price:.2f}", f"${unit_price * item.quantity:.2f}"])
    table_data.append(["", "", "Total", f"${float(order.total_amount):.2f}"])

    table = Table(table_data, colWidths=[3.2 * inch, 0.7 * inch, 1.1 * inch, 1.1 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("LINEABOVE", (0, -1), (-1, -1), 1, colors.black),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -2), 0.5, colors.HexColor("#cbd5e1")),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(table)

    doc.build(story)
    return buffer.getvalue()
