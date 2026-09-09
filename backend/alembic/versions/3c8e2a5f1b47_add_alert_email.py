"""add alert_email to app_settings

Revision ID: 3c8e2a5f1b47
Revises: 7f4a1b6c9d02
Create Date: 2026-09-09 01:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3c8e2a5f1b47'
down_revision: Union[str, Sequence[str], None] = '7f4a1b6c9d02'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('alert_email', sa.String(length=255), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'alert_email')
