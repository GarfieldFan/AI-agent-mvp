"""add image generation provider fields

Revision ID: 7d3b6f8a1c92
Revises: 2f7c4a9d1e83
Create Date: 2026-08-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7d3b6f8a1c92'
down_revision: Union[str, Sequence[str], None] = '2f7c4a9d1e83'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('image_provider', sa.String(length=32), nullable=True))
    op.add_column('app_settings', sa.Column('image_comfyui_url', sa.String(length=500), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'image_comfyui_url')
    op.drop_column('app_settings', 'image_provider')
