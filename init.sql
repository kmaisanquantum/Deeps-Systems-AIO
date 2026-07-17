-- Enable UUID extension if not already present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Idempotent creation of devops_nodes table
CREATE TABLE IF NOT EXISTS devops_nodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    branch_id UUID,
    name VARCHAR(255) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'inactive',
    last_synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Performance index on tenant_id
CREATE INDEX IF NOT EXISTS idx_devops_nodes_tenant_id ON devops_nodes (tenant_id);
