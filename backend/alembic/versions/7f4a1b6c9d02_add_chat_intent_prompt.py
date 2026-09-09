"""add chat_intent_prompt to app_settings

Revision ID: 7f4a1b6c9d02
Revises: 2e88ae50e73a
Create Date: 2026-09-09 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7f4a1b6c9d02'
down_revision: Union[str, Sequence[str], None] = '2e88ae50e73a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('chat_intent_prompt', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'chat_intent_prompt')
