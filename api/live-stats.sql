CREATE TABLE live_stats(singleton INTEGER PRIMARY KEY CHECK(singleton=1),works INTEGER NOT NULL CHECK(works>=0),media INTEGER NOT NULL CHECK(media>=0),authors INTEGER NOT NULL CHECK(authors>=0));
    CREATE TABLE live_metadata_stats(metadata_state TEXT PRIMARY KEY,count INTEGER NOT NULL CHECK(count>=0));
    CREATE TABLE live_platform_stats(platform_id TEXT PRIMARY KEY,count_works INTEGER NOT NULL CHECK(count_works>=0),count_media INTEGER NOT NULL CHECK(count_media>=0),last_revision INTEGER NOT NULL CHECK(last_revision>=0));
