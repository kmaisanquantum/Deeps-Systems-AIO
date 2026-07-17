-- =====================================================================
-- DEEPS SYSTEMS AIO — init.sql
-- Shared-schema, row-level multi-tenant PostgreSQL architecture (UUID PK)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('admin', 'manager', 'employee');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_state') THEN
        CREATE TYPE verification_state AS ENUM ('PENDING', 'VERIFIED', 'FAILED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_type') THEN
        CREATE TYPE transaction_type AS ENUM ('INCOME', 'EXPENSE', 'PAYROLL');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'comm_channel') THEN
        CREATE TYPE comm_channel AS ENUM ('WHATSAPP', 'EMAIL', 'SMS');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'comm_direction') THEN
        CREATE TYPE comm_direction AS ENUM ('INBOUND', 'OUTBOUND');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'carrier_name') THEN
        CREATE TYPE carrier_name AS ENUM ('DHL', 'POST_PNG');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shipping_status') THEN
        CREATE TYPE shipping_status AS ENUM ('PENDING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED');
    END IF;
END $$;

-- Isolated enum update to safely introduce superadmin platform-wide tier
DO $$     BEGIN       IF NOT EXISTS (        SELECT 1 FROM pg_enum e         JOIN pg_type t ON t.oid = e.enumtypid         WHERE t.typname = 'user_role' AND e.enumlabel = 'superadmin'      ) THEN         ALTER TYPE user_role ADD VALUE 'superadmin';       END IF;     END $$;

-- ---------------------------------------------------------------------
-- TENANTS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_name    VARCHAR(255) NOT NULL,
    subdomain       VARCHAR(100) NOT NULL UNIQUE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants (subdomain);

-- ---------------------------------------------------------------------
-- BRANCHES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_name     VARCHAR(255) NOT NULL,
    location_city   VARCHAR(120),
    is_hub          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON branches (tenant_id);

-- ---------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
    full_name       VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            user_role NOT NULL DEFAULT 'employee',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_branch_id ON users (branch_id);

-- ---------------------------------------------------------------------
-- FINANCIAL_TRANSACTIONS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_transactions (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id               UUID REFERENCES branches(id) ON DELETE SET NULL,
    created_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    transaction_type        transaction_type NOT NULL,
    amount                  NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    currency                VARCHAR(3) NOT NULL DEFAULT 'PGK',
    description             TEXT,
    is_manual               BOOLEAN NOT NULL DEFAULT FALSE,
    verification_status     verification_state NOT NULL DEFAULT 'PENDING',
    payment_gateway         VARCHAR(50),        -- e.g. 'BSP_PAY', 'KINA_IPG', 'AKAUNTING', 'CASH'
    gateway_reference_id    VARCHAR(255),
    akaunting_invoice_id    VARCHAR(120),
    occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_tx_tenant_id ON financial_transactions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_branch_id ON financial_transactions (branch_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_verification_status ON financial_transactions (verification_status);
CREATE INDEX IF NOT EXISTS idx_fin_tx_gateway_ref ON financial_transactions (gateway_reference_id);

-- ---------------------------------------------------------------------
-- HR_PROFILES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_profiles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    full_name       VARCHAR(255) NOT NULL,
    position_title  VARCHAR(150),
    salary_amount   NUMERIC(14, 2),
    salary_currency VARCHAR(3) NOT NULL DEFAULT 'PGK',
    hire_date       DATE,
    termination_date DATE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_tenant_id ON hr_profiles (tenant_id);
CREATE INDEX IF NOT EXISTS idx_hr_branch_id ON hr_profiles (branch_id);

-- ---------------------------------------------------------------------
-- COMMUNICATION_LOGS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communication_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
    channel         comm_channel NOT NULL,
    direction       comm_direction NOT NULL,
    sender_ref      VARCHAR(255),   -- phone number / email address / sender id
    recipient_ref   VARCHAR(255),
    raw_payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    parsed_intent   JSONB,          -- structured result from AI intent engine, if any
    status          VARCHAR(50) NOT NULL DEFAULT 'RECEIVED',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comm_logs_tenant_id ON communication_logs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_comm_logs_channel ON communication_logs (channel);
CREATE INDEX IF NOT EXISTS idx_comm_logs_created_at ON communication_logs (created_at);

-- ---------------------------------------------------------------------
-- LOGISTICS_SHIPMENTS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics_shipments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id           UUID REFERENCES branches(id) ON DELETE SET NULL,
    carrier_name        carrier_name NOT NULL,
    tracking_number     VARCHAR(120),
    waybill_reference   VARCHAR(120),
    shipping_status     shipping_status NOT NULL DEFAULT 'PENDING',
    weight_kg           NUMERIC(10, 3),
    freight_cost        NUMERIC(14, 2),
    freight_currency    VARCHAR(3) NOT NULL DEFAULT 'PGK',
    origin_address      TEXT,
    destination_address TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logistics_tenant_id ON logistics_shipments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_logistics_branch_id ON logistics_shipments (branch_id);
CREATE INDEX IF NOT EXISTS idx_logistics_tracking_number ON logistics_shipments (tracking_number);

-- ---------------------------------------------------------------------
-- WEBSITE & ONLINE STORE MODULE
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
    title           VARCHAR(255) NOT NULL,
    price           NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (price >= 0),
    description     TEXT,
    inventory_count INTEGER NOT NULL DEFAULT 0 CHECK (inventory_count >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_items_tenant_id ON store_items (tenant_id);

CREATE TABLE IF NOT EXISTS store_pages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    slug            VARCHAR(255) NOT NULL,
    content         TEXT,
    is_published    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_store_pages_tenant_id ON store_pages (tenant_id);

CREATE TABLE IF NOT EXISTS store_checkouts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    amount          NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    currency        VARCHAR(3) NOT NULL DEFAULT 'PGK',
    email           VARCHAR(255),
    status          VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_checkouts_tenant_id ON store_checkouts (tenant_id);

-- ---------------------------------------------------------------------
-- SALES & MARKETING MODULE
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_leads (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    full_name       VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    deal_value      NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (deal_value >= 0),
    stage           VARCHAR(50) NOT NULL DEFAULT 'Prospect',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_leads_tenant_id ON sales_leads (tenant_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_leads_stage_check') THEN
        ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_stage_check CHECK (stage IN ('Prospect','Contacted','Qualified','Won','Lost'));
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- WORKSPACE (VIRTUAL OFFICE) MODULE
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_tasks (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id           UUID REFERENCES branches(id) ON DELETE SET NULL,
    title               VARCHAR(255) NOT NULL,
    description         TEXT,
    assignee_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    status              VARCHAR(50) NOT NULL DEFAULT 'TODO',
    priority            VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
    due_date            DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_tasks_tenant ON workspace_tasks (tenant_id);

CREATE TABLE IF NOT EXISTS workspace_events (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id           UUID REFERENCES branches(id) ON DELETE SET NULL,
    title               VARCHAR(255) NOT NULL,
    description         TEXT,
    starts_at           TIMESTAMPTZ NOT NULL,
    ends_at             TIMESTAMPTZ,
    location            VARCHAR(255),
    organizer_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_events_tenant ON workspace_events (tenant_id);

CREATE TABLE IF NOT EXISTS workspace_documents (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id           UUID REFERENCES branches(id) ON DELETE SET NULL,
    title               VARCHAR(255) NOT NULL,
    category            VARCHAR(50),
    url                 TEXT,
    content             TEXT,
    status              VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_documents_tenant ON workspace_documents (tenant_id);

-- ---------------------------------------------------------------------
-- updated_at auto-touch trigger (applied to all mutable tables)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_tenants ON tenants;
CREATE TRIGGER set_updated_at_tenants BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_branches ON branches;
CREATE TRIGGER set_updated_at_branches BEFORE UPDATE ON branches
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_users ON users;
CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_fin_tx ON financial_transactions;
CREATE TRIGGER set_updated_at_fin_tx BEFORE UPDATE ON financial_transactions
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_hr ON hr_profiles;
CREATE TRIGGER set_updated_at_hr BEFORE UPDATE ON hr_profiles
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_logistics ON logistics_shipments;
CREATE TRIGGER set_updated_at_logistics BEFORE UPDATE ON logistics_shipments
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_store_items ON store_items;
CREATE TRIGGER set_updated_at_store_items BEFORE UPDATE ON store_items
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_store_pages ON store_pages;
CREATE TRIGGER set_updated_at_store_pages BEFORE UPDATE ON store_pages
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_store_checkouts ON store_checkouts;
CREATE TRIGGER set_updated_at_store_checkouts BEFORE UPDATE ON store_checkouts
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_sales_leads ON sales_leads;
CREATE TRIGGER set_updated_at_sales_leads BEFORE UPDATE ON sales_leads
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_workspace_tasks ON workspace_tasks;
CREATE TRIGGER set_updated_at_workspace_tasks BEFORE UPDATE ON workspace_tasks
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_workspace_events ON workspace_events;
CREATE TRIGGER set_updated_at_workspace_events BEFORE UPDATE ON workspace_events
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_workspace_documents ON workspace_documents;
CREATE TRIGGER set_updated_at_workspace_documents BEFORE UPDATE ON workspace_documents
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ==========================================
-- PRIMARY ADMINISTRATIVE DATA SEED
-- ==========================================

-- 1. Ensure a primary organizational tenant exists for the workspace domain
INSERT INTO tenants (company_name, subdomain, is_active)
VALUES ('Deeps Systems', 'deeps', true)
ON CONFLICT (subdomain) DO NOTHING;

-- 2. Seed the global administrator user account bound to the initialized tenant
-- NOTE: The system leaves this legacy un-salted SHA-256 password hash intact in the seed.
-- Upon the first successful authentication/login of this user, the system automatically
-- runs a transparent "upgrade-on-login" cycle in the application layer to upgrade this hash
-- to a salted, highly secure cost-12 bcrypt representation.
INSERT INTO users (tenant_id, full_name, email, password_hash, role)
SELECT
    id,
    'Kmaisan',
    'kmaisan@dspng.tech',  -- Kept lowercase to match runtime login normalizations
    encode(digest('KapisRocket@2026', 'sha256'), 'hex'),
    'admin'
FROM tenants
WHERE subdomain = 'deeps'
ON CONFLICT (tenant_id, email) DO NOTHING;

-- ---------------------------------------------------------------------
-- DEVOPS ENGINE MODULE
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devops_nodes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    provider        VARCHAR(50) NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          VARCHAR(50) NOT NULL DEFAULT 'inactive',
    last_synced_at  TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devops_nodes_tenant_id ON devops_nodes (tenant_id);

DROP TRIGGER IF EXISTS set_updated_at_devops_nodes ON devops_nodes;
CREATE TRIGGER set_updated_at_devops_nodes BEFORE UPDATE ON devops_nodes
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =========================================================================
-- LEARNING PATHWAY ADDITIONS
-- =========================================================================

CREATE TABLE IF NOT EXISTS learning_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    category VARCHAR(100),
    description TEXT,
    provider VARCHAR(150),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_resources_tenant_id ON learning_resources(tenant_id);

CREATE TABLE IF NOT EXISTS study_schedule (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    topic VARCHAR(255),
    resource_id UUID REFERENCES learning_resources(id) ON DELETE SET NULL,
    scheduled_at TIMESTAMPTZ,
    duration_minutes INTEGER,
    status VARCHAR(50) NOT NULL DEFAULT 'Planned',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_schedule_tenant_id ON study_schedule(tenant_id);

-- Helper trigger function if not exists
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach standard updated_at triggers
DROP TRIGGER IF EXISTS set_timestamp_learning_resources ON learning_resources;
CREATE TRIGGER set_timestamp_learning_resources
BEFORE UPDATE ON learning_resources
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

DROP TRIGGER IF EXISTS set_timestamp_study_schedule ON study_schedule;
CREATE TRIGGER set_timestamp_study_schedule
BEFORE UPDATE ON study_schedule
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

-- =========================================================================
-- SERVICE FEES (OPERATIONS) ADDITIONS
-- =========================================================================

CREATE TABLE IF NOT EXISTS service_fees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    fee_name VARCHAR(255) NOT NULL,
    provider VARCHAR(150),
    category VARCHAR(100) NOT NULL DEFAULT 'OTHER', -- HOSTING, IPA, IRC, DOMAIN, OTHER
    amount NUMERIC(14,2) NOT NULL DEFAULT 0.00 CHECK (amount >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'PGK',
    billing_cycle VARCHAR(20) NOT NULL DEFAULT 'MONTHLY', -- MONTHLY, QUARTERLY, ANNUAL, ONE_OFF
    next_due_date DATE,
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, PAID, OVERDUE, CANCELLED
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_fees_tenant_id ON service_fees (tenant_id);

-- Attach standard updated_at modification trigger
DROP TRIGGER IF EXISTS set_timestamp_service_fees ON service_fees;
CREATE TRIGGER set_timestamp_service_fees
BEFORE UPDATE ON service_fees
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

-- =========================================================================
-- DEVOPS CI/CD PIPELINE ADDITIONS
-- =========================================================================

-- Guarded ENUM type creation
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'devops_pipeline_stage') THEN
        CREATE TYPE devops_pipeline_stage AS ENUM (
            'PLAN', 'CODE', 'BUILD', 'TEST', 'RELEASE', 'DEPLOY', 'OPERATE', 'MONITOR'
        );
    END IF;
END $$;

-- Idempotent Pipelines Table
CREATE TABLE IF NOT EXISTS devops_pipelines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID,
    node_id UUID REFERENCES devops_nodes(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    current_stage devops_pipeline_stage NOT NULL DEFAULT 'PLAN',
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    cycle_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devops_pipelines_tenant_id ON devops_pipelines(tenant_id);

-- Idempotent Pipeline Stage Events Table (Stage History)
CREATE TABLE IF NOT EXISTS devops_pipeline_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pipeline_id UUID NOT NULL REFERENCES devops_pipelines(id) ON DELETE CASCADE,
    stage devops_pipeline_stage NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devops_pipeline_events_pipeline_id ON devops_pipeline_events(pipeline_id);

-- Attach modification trigger to pipelines
DROP TRIGGER IF EXISTS set_timestamp_devops_pipelines ON devops_pipelines;
CREATE TRIGGER set_timestamp_devops_pipelines
BEFORE UPDATE ON devops_pipelines
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

-- =========================================================================
-- DEVOPS CREDENTIALS ADDITIONS
-- =========================================================================

CREATE TABLE IF NOT EXISTS devops_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    secret_encrypted BYTEA NOT NULL,
    base_url VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_devops_credentials_tenant ON devops_credentials(tenant_id);

-- Attach standard updated_at trigger
DROP TRIGGER IF EXISTS set_timestamp_devops_credentials ON devops_credentials;
CREATE TRIGGER set_timestamp_devops_credentials
BEFORE UPDATE ON devops_credentials
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

-- =========================================================================
-- CONNECTED SITES ADDITIONS
-- =========================================================================

CREATE TABLE IF NOT EXISTS connected_sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label VARCHAR(255) NOT NULL,
    url VARCHAR(500) NOT NULL,
    last_status VARCHAR(20),
    last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connected_sites_tenant ON connected_sites(tenant_id);

-- Attach standard updated_at trigger
DROP TRIGGER IF EXISTS set_timestamp_connected_sites ON connected_sites;
CREATE TRIGGER set_timestamp_connected_sites
BEFORE UPDATE ON connected_sites
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();
