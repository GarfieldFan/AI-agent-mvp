"""add intent_schemas/intent_fields tables and crm_entries columns

Revision ID: a7d3e9f1c5b2
Revises: f3c8d2a5e6b1
Create Date: 2026-08-19 00:00:00.000003

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a7d3e9f1c5b2'
down_revision: Union[str, Sequence[str], None] = 'f3c8d2a5e6b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'intent_schemas',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('key', sa.String(length=64), nullable=False),
        sa.Column('label', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key'),
    )
    op.create_table(
        'intent_fields',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('intent_schema_id', sa.Integer(), nullable=False),
        sa.Column('field_key', sa.String(length=64), nullable=False),
        sa.Column('label', sa.String(length=255), nullable=False),
        sa.Column('field_type', sa.String(length=16), nullable=False, server_default='text'),
        sa.Column('required', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('prompt_hint', sa.Text(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.ForeignKeyConstraint(['intent_schema_id'], ['intent_schemas.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.add_column('crm_entries', sa.Column('intent_schema_id', sa.Integer(), nullable=True))
    op.add_column(
        'crm_entries',
        sa.Column('collected_fields', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='{}'),
    )
    op.add_column('crm_entries', sa.Column('chat_session_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_crm_entries_intent_schema_id', 'crm_entries', 'intent_schemas', ['intent_schema_id'], ['id'],
        ondelete='SET NULL',
    )
    op.create_foreign_key(
        'fk_crm_entries_chat_session_id', 'crm_entries', 'chat_sessions', ['chat_session_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_crm_entries_chat_session_id', 'crm_entries', type_='foreignkey')
    op.drop_constraint('fk_crm_entries_intent_schema_id', 'crm_entries', type_='foreignkey')
    op.drop_column('crm_entries', 'chat_session_id')
    op.drop_column('crm_entries', 'collected_fields')
    op.drop_column('crm_entries', 'intent_schema_id')
    op.drop_table('intent_fields')
    op.drop_table('intent_schemas')
