"""add owner_agent_runs table

Revision ID: f3c8d2a5e6b1
Revises: e1a4b7c9d2f3
Create Date: 2026-08-19 00:00:00.000002

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'f3c8d2a5e6b1'
down_revision: Union[str, Sequence[str], None] = 'e1a4b7c9d2f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'owner_agent_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('owner_email', sa.String(length=255), nullable=False),
        sa.Column('command', sa.Text(), nullable=False),
        sa.Column('final_answer', sa.Text(), nullable=False),
        sa.Column('stopped_reason', sa.String(length=50), nullable=False),
        sa.Column('steps', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('owner_agent_runs')
