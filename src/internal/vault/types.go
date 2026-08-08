package vault

import "time"

const SchemaVersion = 1

// Audit actions.
const (
	ActionDump          = "dump"
	ActionRestore       = "restore"
	ActionSync          = "sync"
	ActionS3Upload      = "s3_upload"
	ActionS3Download    = "s3_download"
	ActionSecretWipe    = "secret_wipe"
	ActionMasterChange  = "master_change"
	ActionConfigInit    = "config_init"
	ActionDumpScan      = "dump_scan"
	ActionDumpVerify    = "dump_verify"
	ActionConnection    = "connection"
)

// Audit status values.
const (
	StatusSuccess   = "success"
	StatusFailure   = "failure"
	StatusCancelled = "cancelled"
)

// Secret rotation actions (no plaintext stored).
const (
	RotationCreated         = "created"
	RotationUpdated         = "updated"
	RotationWiped           = "wiped"
	RotationMasterReencrypt = "master_reencrypt"
)

type SecretInfo struct {
	Key        string
	CreatedAt  time.Time
	UpdatedAt  time.Time
	LastUsedAt *time.Time
}

type SecretRotation struct {
	ID        int64
	SecretKey string
	Action    string
	RotatedAt time.Time
}

type AuditEntry struct {
	ID           int64
	OccurredAt   time.Time
	Action       string
	Status       string
	Subject      string
	Destination  string
	Details      string
	ErrorMessage string
}

type DumpRecord struct {
	ID           int64
	RelativePath string
	ItemKey      string
	FileName     string
	SHA256       string
	SizeBytes    int64
	Encrypted    bool
	EncID        string
	CreatedAt    time.Time
}

type RestoreRecord struct {
	ID               int64
	DumpID           *int64
	DumpRelativePath string
	DumpSHA256       string
	DestinationKey   string
	RestoredAt       time.Time
	DurationMS       int64
	Status           string
	CleanRestore     bool
	Warnings         string
	ErrorMessage     string
}

type Status struct {
	DBPath       string
	SchemaVersion int
	HasMaster    bool
	EncID        string
	SecretCount  int
	DumpCount    int
	AuditCount   int
	RestoreCount int
}
