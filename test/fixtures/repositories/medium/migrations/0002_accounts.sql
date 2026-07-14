CREATE TABLE fixture_accounts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES fixture_users(id)
);

CREATE INDEX idx_fixture_accounts_owner ON fixture_accounts(owner_id);
