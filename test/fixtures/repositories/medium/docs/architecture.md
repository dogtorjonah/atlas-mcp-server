# Medium fixture architecture

The API layer calls deterministic services. Services depend on repository
functions, and repository functions own the fixture's in-memory state.
