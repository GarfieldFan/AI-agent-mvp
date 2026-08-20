"""replace product category with tags

Revision ID: d9feed93def7
Revises: 65235cfb36c2
Create Date: 2026-08-20 04:27:08.235780

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'd9feed93def7'
down_revision: Union[str, Sequence[str], None] = '65235cfb36c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Data-preserving, not a plain add/drop: a real product's category
    (e.g. "Coffee") gets carried over into tags as a one-element list
    rather than silently discarded — see models.Product's docstring for
    why category was replaced (a single rigid value vs. a free list that
    can also fix cross-lingual search misses)."""
    op.add_column(
        'products', sa.Column('tags', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='[]')
    )
    op.execute(
        "UPDATE products SET tags = jsonb_build_array(category) "
        "WHERE category IS NOT NULL AND category <> ''"
    )
    op.drop_column('products', 'category')


def downgrade() -> None:
    """Downgrade schema — takes the first tag back as category (lossy if
    a product had more than one tag, but there's no other sensible single
    value to pick)."""
    op.add_column('products', sa.Column('category', sa.VARCHAR(length=100), autoincrement=False, nullable=True))
    op.execute("UPDATE products SET category = tags->>0 WHERE jsonb_array_length(tags) > 0")
    op.drop_column('products', 'tags')
