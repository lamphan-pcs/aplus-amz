CREATE TABLE IF NOT EXISTS products (
    id              SERIAL PRIMARY KEY,
    asin            VARCHAR(10)  UNIQUE NOT NULL,
    product_name    TEXT,
    sku             TEXT,
    aplus_level     VARCHAR(20)  DEFAULT 'None',   -- 'None' | 'A+ Standard' | 'A+ Premium'
    has_brand_story BOOLEAN      DEFAULT false,
    aplus_html      TEXT,
    brand_story_html TEXT,
    feature_bullets TEXT,
    module_count    INT          DEFAULT 0,
    scraped_at      TIMESTAMPTZ  DEFAULT now(),
    updated_at      TIMESTAMPTZ  DEFAULT now(),
    search_vector   TSVECTOR
);

-- Migration: add feature_bullets to existing databases
ALTER TABLE products ADD COLUMN IF NOT EXISTS feature_bullets TEXT;

-- GIN index for full-text search (fast even with 100k+ rows)
CREATE INDEX IF NOT EXISTS idx_products_search ON products USING GIN (search_vector);

-- Index for filtering by level
CREATE INDEX IF NOT EXISTS idx_products_level ON products (aplus_level);

-- Function to rebuild search_vector from name + asin + sku
CREATE OR REPLACE FUNCTION products_search_vector_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.product_name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.asin, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.sku, '')), 'B');
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger fires on every insert or update
DROP TRIGGER IF EXISTS products_search_vector_trigger ON products;
CREATE TRIGGER products_search_vector_trigger
    BEFORE INSERT OR UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION products_search_vector_update();
