"""add custom provider fields to app_settings

Revision ID: 9c2a5e1f6b3d
Revises: fd073dfac6fd
Create Date: 2026-08-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9c2a5e1f6b3d'
down_revision: Union[str, Sequence[str], None] = 'fd073dfac6fd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('custom_base_url', sa.String(length=500), nullable=True))
    op.add_column('app_settings', sa.Column('custom_api_key', sa.String(length=255), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'custom_api_key')
    op.drop_column('app_settings', 'custom_base_url')
