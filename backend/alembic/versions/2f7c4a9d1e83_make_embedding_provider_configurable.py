"""make embedding provider configurable

Revision ID: 2f7c4a9d1e83
Revises: 9c2a5e1f6b3d
Create Date: 2026-08-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2f7c4a9d1e83'
down_revision: Union[str, Sequence[str], None] = '9c2a5e1f6b3d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('app_settings', sa.Column('embedding_provider', sa.String(length=32), nullable=True))
    op.add_column('app_settings', sa.Column('embedding_model', sa.String(length=200), nullable=True))
    op.add_column('app_settings', sa.Column('embedding_dimensions', sa.Integer(), nullable=True))
    op.add_column('documents', sa.Column('embedding_provider', sa.String(length=32), nullable=True))
    op.add_column('documents', sa.Column('embedding_model', sa.String(length=200), nullable=True))

    # Every document ready today was in fact embedded via Ollama — the
    # only embedding provider that's ever been configurable until this
    # migration (EMBEDDING_PROVIDER defaulted to "ollama" and nothing
    # else set it) — so this is a factual backfill, not a guess.
    op.execute(
        "UPDATE documents SET embedding_provider = 'ollama', embedding_model = 'nomic-embed-text' "
        "WHERE status = 'ready'"
    )

    # Drop the fixed 768-dim width — different providers produce
    # different-length vectors, and consistency across rows is now an
    # application-level invariant (apis/model_settings.py's
    # update_settings clears document_chunks whenever the embedding
    # provider/model actually changes) rather than a DB-level one. Safe
    # to relax on existing 768-dim data — this widens the constraint, it
    # doesn't narrow it.
    op.execute("ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector")


def downgrade() -> None:
    """Downgrade schema."""
    # Only valid if every row is still actually 768-dim at downgrade
    # time — true immediately after this migration, not guaranteed if an
    # embedding provider switch happened since.
    op.execute("ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(768)")

    op.drop_column('documents', 'embedding_model')
    op.drop_column('documents', 'embedding_provider')
    op.drop_column('app_settings', 'embedding_dimensions')
    op.drop_column('app_settings', 'embedding_model')
    op.drop_column('app_settings', 'embedding_provider')
