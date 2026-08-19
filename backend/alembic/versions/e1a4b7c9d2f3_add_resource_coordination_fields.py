"""add resource coordination fields

Revision ID: e1a4b7c9d2f3
Revises: d7f2a8c1b4e9
Create Date: 2026-08-19 00:00:00.000001

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e1a4b7c9d2f3'
down_revision: Union[str, Sequence[str], None] = 'd7f2a8c1b4e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'app_settings',
        sa.Column('resource_coordination_enabled', sa.Boolean(), nullable=False, server_default='false'),
    )
    op.add_column(
        'app_settings',
        sa.Column('resource_coordination_headroom_mb', sa.Integer(), nullable=False, server_default='4096'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('app_settings', 'resource_coordination_headroom_mb')
    op.drop_column('app_settings', 'resource_coordination_enabled')
