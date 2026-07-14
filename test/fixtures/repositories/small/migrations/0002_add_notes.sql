ALTER TABLE fixture_items ADD COLUMN note TEXT;

CREATE INDEX idx_fixture_items_note ON fixture_items(note);
