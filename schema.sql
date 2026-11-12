
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    token_hash TEXT NOT NULL,

    amount INTEGER NOT NULL
        CHECK (amount >= 1000 AND amount <= 50000),

    term INTEGER NOT NULL
        CHECK (term >= 1 AND term <= 12),

    purpose VARCHAR(100) NOT NULL,
    purpose_details VARCHAR(1000),

    first_name VARCHAR(80) NOT NULL,
    last_name VARCHAR(80) NOT NULL,
    email VARCHAR(254) NOT NULL,
    phone VARCHAR(20) NOT NULL,

    status VARCHAR(40) NOT NULL DEFAULT 'pending_verification'
        CHECK (
            status IN (
                'pending_verification',
                'pending_admin',
                'approved',
                'rejected',
                'completed'
            )
        ),

    application_code_hash TEXT,
    application_code_expires TIMESTAMPTZ,

    final_code_hash TEXT,
    final_code_expires TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS applications_status_idx
ON applications(status);

CREATE INDEX IF NOT EXISTS applications_created_at_idx
ON applications(created_at);

CREATE INDEX IF NOT EXISTS applications_phone_idx
ON applications(phone);
