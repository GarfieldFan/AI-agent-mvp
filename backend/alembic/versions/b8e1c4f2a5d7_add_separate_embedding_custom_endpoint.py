"""add separate embedding custom endpoint fields

Revision ID: b8e1c4f2a5d7
Revises: 7d3b6f8a1c92
Create Date: 2026-08-18 00:00:00.000001

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8e1c4f2a5d7'
down_revision: Union[str, Sequence[str], None] = '7d3b6f8a1c92'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('embedding_base_url', sa.String(length=500), nullable=True))
    op.add_column('app_settings', sa.Column('embedding_api_key', sa.String(length=255), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'embedding_api_key')
    op.drop_column('app_settings', 'embedding_base_url')
