"""add comfyui checkpoint (unet/clip/vae) fields

Revision ID: c4d9f1a3e6b8
Revises: b8e1c4f2a5d7
Create Date: 2026-08-18 00:00:00.000002

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4d9f1a3e6b8'
down_revision: Union[str, Sequence[str], None] = 'b8e1c4f2a5d7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('image_comfyui_unet', sa.String(length=300), nullable=True))
    op.add_column('app_settings', sa.Column('image_comfyui_clip', sa.String(length=300), nullable=True))
    op.add_column('app_settings', sa.Column('image_comfyui_vae', sa.String(length=300), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'image_comfyui_vae')
    op.drop_column('app_settings', 'image_comfyui_clip')
    op.drop_column('app_settings', 'image_comfyui_unet')
