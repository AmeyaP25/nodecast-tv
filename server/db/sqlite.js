const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Vercel does not allow writing to the deployed application directory.
// /tmp is writable during a serverless function's lifetime.
// For local/normal server use, keep using the project's data directory.
const dataDir = process.env.VERCEL
    ? '/tmp/nodecast-data'
    : path.join(__dirname, '..', '..', 'data');

const dbPath = path.join(dataDir, 'content.db');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
    if (!db) {
        console.log('[SQLite] Opening database at', dbPath);
        db = new Database(dbPath);

        // Optimize performance
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');

        initSchema();
    }

    return db;
}

function initSchema() {
    if (!db) throw new Error('Database not initialized');

    // Categories (Groups)
    db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            source_id INTEGER NOT NULL,
            category_id TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            parent_id TEXT,
            is_hidden INTEGER DEFAULT 0,
            data JSON
        );

        CREATE INDEX IF NOT EXISTS idx_categories_source_type
        ON categories(source_id, type);
    `);

    // Playlist Items (Channels, Movies, Series, Episodes)
    db.exec(`
        CREATE TABLE IF NOT EXISTS playlist_items (
            id TEXT PRIMARY KEY,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            category_id TEXT,
            parent_id TEXT,

            stream_icon TEXT,
            stream_url TEXT,
            container_extension TEXT,

            rating REAL,
            year TEXT,
            added_at TEXT,

            is_hidden INTEGER DEFAULT 0,
            is_favorite INTEGER DEFAULT 0,

            data JSON
        );

        CREATE INDEX IF NOT EXISTS idx_items_source_type
        ON playlist_items(source_id, type);

        CREATE INDEX IF NOT EXISTS idx_items_category
        ON playlist_items(source_id, category_id);
    `);

    // EPG Programs
    db.exec(`
        CREATE TABLE IF NOT EXISTS epg_programs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            start_time INTEGER NOT NULL,
            end_time INTEGER NOT NULL,
            title TEXT,
            description TEXT,
            data JSON
        );

        CREATE INDEX IF NOT EXISTS idx_epg_channel_time
        ON epg_programs(channel_id, start_time, end_time);

        CREATE INDEX IF NOT EXISTS idx_epg_cleanup
        ON epg_programs(end_time);
    `);

    // Sync Status
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_status (
            source_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            last_sync INTEGER NOT NULL,
            status TEXT,
            error TEXT,
            PRIMARY KEY (source_id, type)
        );
    `);

    // User Favorites (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, source_id, item_id, item_type)
        );

        CREATE INDEX IF NOT EXISTS idx_favorites_user
        ON favorites(user_id);

        CREATE INDEX IF NOT EXISTS idx_favorites_user_type
        ON favorites(user_id, item_type);
    `);

    // Watch History (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS watch_history (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            source_id INTEGER,
            item_type TEXT NOT NULL,
            item_id TEXT NOT NULL,
            parent_id TEXT,
            progress INTEGER DEFAULT 0,
            duration INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL,
            data JSON
        );

        CREATE INDEX IF NOT EXISTS idx_history_user_updated
        ON watch_history(user_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_history_user_item
        ON watch_history(user_id, item_id);
    `);

    // Migration: Add source_id column if missing
    try {
        db.exec(`
            ALTER TABLE watch_history
            ADD COLUMN source_id INTEGER
        `);

        console.log('[SQLite] Added source_id column to watch_history');
    } catch (e) {
        // Column already exists, ignore
    }

    console.log('[SQLite] Schema initialized');
}

// ============================================================
// Favorites CRUD Operations
// ============================================================

const favorites = {
    getAll(userId, sourceId = null, itemType = null) {
        const db = getDb();

        let sql = 'SELECT * FROM favorites WHERE user_id = ?';
        const params = [userId];

        if (sourceId) {
            sql += ' AND source_id = ?';
            params.push(sourceId);
        }

        if (itemType) {
            sql += ' AND item_type = ?';
            params.push(itemType);
        }

        sql += ' ORDER BY created_at DESC';

        return db.prepare(sql).all(...params);
    },

    add(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();

        const stmt = db.prepare(`
            INSERT OR IGNORE INTO favorites
            (user_id, source_id, item_id, item_type)
            VALUES (?, ?, ?, ?)
        `);

        const result = stmt.run(
            userId,
            sourceId,
            itemId,
            itemType
        );

        return result.changes > 0;
    },

    remove(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();

        const stmt = db.prepare(`
            DELETE FROM favorites
            WHERE user_id = ?
            AND source_id = ?
            AND item_id = ?
            AND item_type = ?
        `);

        const result = stmt.run(
            userId,
            sourceId,
            itemId,
            itemType
        );

        return result.changes > 0;
    },

    isFavorite(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();

        const row = db.prepare(`
            SELECT 1
            FROM favorites
            WHERE user_id = ?
            AND source_id = ?
            AND item_id = ?
            AND item_type = ?
        `).get(
            userId,
            sourceId,
            itemId,
            itemType
        );

        return !!row;
    },

    // Get all favorites for a user, grouped by type
    getAllAsSet(userId) {
        const db = getDb();

        const rows = db.prepare(`
            SELECT source_id, item_id, item_type
            FROM favorites
            WHERE user_id = ?
        `).all(userId);

        const set = new Set();

        for (const row of rows) {
            set.add(
                `${row.source_id}:${row.item_id}:${row.item_type}`
            );
        }

        return set;
    }
};

module.exports = {
    getDb,
    initSchema,
    favorites
};
