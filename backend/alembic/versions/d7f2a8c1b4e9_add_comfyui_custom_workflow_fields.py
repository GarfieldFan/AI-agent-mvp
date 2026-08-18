"""add comfyui custom workflow fields

Revision ID: d7f2a8c1b4e9
Revises: c4d9f1a3e6b8
Create Date: 2026-08-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd7f2a8c1b4e9'
down_revision: Union[str, Sequence[str], None] = 'c4d9f1a3e6b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('image_comfyui_workflow', sa.Text(), nullable=True))
    op.add_column('app_settings', sa.Column('image_comfyui_prompt_node', sa.String(length=50), nullable=True))
    op.add_column('app_settings', sa.Column('image_comfyui_prompt_field', sa.String(length=100), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'image_comfyui_prompt_field')
    op.drop_column('app_settings', 'image_comfyui_prompt_node')
    op.drop_column('app_settings', 'image_comfyui_workflow')
