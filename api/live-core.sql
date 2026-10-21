CREATE TABLE live_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,base_generation_id TEXT,epoch TEXT NOT NULL,revision INTEGER NOT NULL,initialized_at_ms INTEGER NOT NULL);
        CREATE TABLE live_id_high_water(entity TEXT PRIMARY KEY,value INTEGER NOT NULL);
