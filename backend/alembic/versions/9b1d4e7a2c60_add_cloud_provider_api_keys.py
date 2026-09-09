"""add cloud provider api keys to app_settings

Revision ID: 9b1d4e7a2c60
Revises: 3c8e2a5f1b47
Create Date: 2026-09-09 02:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9b1d4e7a2c60'
down_revision: Union[str, Sequence[str], None] = '3c8e2a5f1b47'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('openai_api_key', sa.String(length=255), nullable=True))
    op.add_column('app_settings', sa.Column('anthropic_api_key', sa.String(length=255), nullable=True))
    op.add_column('app_settings', sa.Column('gemini_api_key', sa.String(length=255), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'gemini_api_key')
    op.drop_column('app_settings', 'anthropic_api_key')
    op.drop_column('app_settings', 'openai_api_key')
