# expect.ps1 -- register a Taskmaster supervision expectation in one line.
#
# THE POINT (bdc-xo#2007): on 2026-09-11 registering ONE expectation took an scp
# to the production host, the discovery that the database is readonly to the ssh
# user, the discovery that sqlite3 is not in the container, and finally a
# `sudo sqlite3` INSERT as root. This script exists so that never happens again.
# Do not hand-write SQL against tm_expectations.
#
# USAGE
#   ./expect.ps1 -Ref bdc-xo#2006 -Recipient fable-cursor `
#                -Evidence pr_opened:thinmansoftware/fuelglass `
#                -DueIn 24h -OnAbsence escalate
#
# EVIDENCE FORMS (all six kinds #1850 specified are reachable):
#   pr_opened:<owner/repo>[:<head-branch>]
#   issue_comment_exists:<owner/repo>#<number>[:<author>]
#   label_present:<owner/repo>#<number>:<label>
#   lease_holder_is:<name>
#   dispatch_reply_exists:<correlation-id>
#   db_row_exists:<table>:<column>=<value>[,<column>=<value>...]
#
# DueIn accepts 30m / 4h / 3d. Or pass -DueAt with an ISO-8601 instant.
#
# The API is reached over ssh at the container's own port. The public DNS name
# sits behind Cloudflare Access and 302s API calls to a login wall -- do not
# curl it.

[CmdletBinding()]
param(
    # What work this supervises. Free text; a GitHub ref like "bdc-xo#2006" is
    # the usual shape. MUST be a dispatch message id when -OnAbsence redispatch,
    # because that path replays the original dispatch by this id.
    [Parameter(Mandatory = $true)][string]$Ref,

    # Who owes the proof. A seat name ("fable-cursor"), a person, a principal.
    [Parameter(Mandatory = $true)][string]$Recipient,

    # What proof would show the work landed. See EVIDENCE FORMS above.
    [Parameter(Mandatory = $true)][string]$Evidence,

    [string]$DueIn,
    [string]$DueAt,

    [ValidateSet('redispatch', 'escalate', 'give_up')]
    [string]$OnAbsence = 'escalate',

    [ValidateRange(0, 5)][int]$MaxRetries = 0,

    # Who is asking. Recorded on the row, and the denominator for the daily cap.
    [string]$RegisteredBy = 'xo',

    # Idempotency. Defaults to a stable digest of (registrant, ref, recipient,
    # evidence) so re-running this command for the same work matches the
    # existing row instead of opening a second one. Pass -Key to override.
    [string]$Key,

    [string]$SshHost = 'hetzner-prod',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Convert-EvidenceSpec {
    param([string]$Text)

    $kind, $rest = $Text -split ':', 2
    if (-not $rest) {
        throw "Evidence needs a value: '$Text'. See EVIDENCE FORMS in this script's header."
    }

    switch ($kind) {
        'pr_opened' {
            $repo, $branch = $rest -split ':', 2
            $spec = @{ kind = 'pr_opened'; repo = $repo }
            if ($branch) { $spec['head_branch'] = $branch }
            return $spec
        }
        'issue_comment_exists' {
            # <owner/repo>#<number>[:<author>]
            if ($rest -notmatch '^(?<repo>[^#]+)#(?<num>\d+)(?::(?<author>.+))?$') {
                throw "issue_comment_exists needs <owner/repo>#<number>[:<author>], got '$rest'"
            }
            $spec = @{
                kind   = 'issue_comment_exists'
                repo   = $Matches['repo']
                number = [int]$Matches['num']
            }
            if ($Matches['author']) { $spec['author'] = $Matches['author'] }
            return $spec
        }
        'label_present' {
            if ($rest -notmatch '^(?<repo>[^#]+)#(?<num>\d+):(?<label>.+)$') {
                throw "label_present needs <owner/repo>#<number>:<label>, got '$rest'"
            }
            return @{
                kind   = 'label_present'
                repo   = $Matches['repo']
                number = [int]$Matches['num']
                label  = $Matches['label']
            }
        }
        'lease_holder_is' { return @{ kind = 'lease_holder_is'; name = $rest } }
        'dispatch_reply_exists' {
            return @{ kind = 'dispatch_reply_exists'; correlation_id = $rest }
        }
        'db_row_exists' {
            $table, $predicates = $rest -split ':', 2
            if (-not $predicates) {
                throw "db_row_exists needs <table>:<column>=<value>[,...], got '$rest'"
            }
            $where = @{}
            foreach ($pair in ($predicates -split ',')) {
                $col, $val = $pair -split '=', 2
                if (-not $col -or $null -eq $val) {
                    throw "db_row_exists predicate must be <column>=<value>, got '$pair'"
                }
                $where[$col] = $val
            }
            return @{ kind = 'db_row_exists'; table = $table; where = $where }
        }
        default {
            throw "Unknown evidence kind '$kind'. Valid: pr_opened, issue_comment_exists, label_present, lease_holder_is, dispatch_reply_exists, db_row_exists."
        }
    }
}

function Convert-Duration {
    param([string]$Text)
    if ($Text -notmatch '^(?<n>\d+)(?<unit>[mhd])$') {
        throw "DueIn must look like 30m, 4h or 3d; got '$Text'"
    }
    $n = [int]$Matches['n']
    switch ($Matches['unit']) {
        'm' { return $n }
        'h' { return $n * 60 }
        'd' { return $n * 60 * 24 }
    }
}

if ($DueIn -and $DueAt) { throw 'Pass exactly one of -DueIn or -DueAt.' }
if (-not $DueIn -and -not $DueAt) { throw 'Pass one of -DueIn (e.g. 24h) or -DueAt (ISO-8601).' }

$spec = Convert-EvidenceSpec -Text $Evidence

if (-not $Key) {
    # Stable across runs for the same work, so a re-run is idempotent rather
    # than a second expectation. Truncated to keep the key readable in logs; 16
    # hex chars of SHA-256 is ample to separate one session's registrations.
    $seed = "$RegisteredBy|$Ref|$Recipient|$Evidence"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($seed))
    } finally {
        $sha.Dispose()
    }
    $digest = -join ($bytes[0..7] | ForEach-Object { $_.ToString('x2') })
    $Key = "$($Ref -replace '[^A-Za-z0-9#._-]', '-')-$digest"
}

# NO COLONS in either component. The server stores the key as
# "ext:<registered_by>:<key>", so a colon inside either half makes that
# construction ambiguous -- ('xo:a','12345678') and ('xo','a:12345678') would
# render the same stored key, and the second caller would be handed the FIRST
# one's expectation with its deadline, believing work is supervised that nothing
# is watching. The API rejects it; catching it here gives a usable message
# instead of a 400 from a body the caller thought was fine.
if ($Key -notmatch '^[A-Za-z0-9_.@#/+-]+$') {
    throw "Key '$Key' may contain only letters, digits and _ . @ # / + - (no ':' or spaces)."
}
if ($RegisteredBy -notmatch '^[A-Za-z0-9_.@+-]+$') {
    throw "RegisteredBy '$RegisteredBy' may contain only letters, digits and _ . @ + - (no ':' or spaces)."
}
if ($Key.Length -lt 8) {
    throw "Key '$Key' is shorter than the 8 characters the API requires."
}

$payload = @{
    registration_key = $Key
    dispatch_ref     = $Ref
    recipient        = $Recipient
    evidence         = $spec
    on_absence       = $OnAbsence
    max_retries      = $MaxRetries
    registered_by    = $RegisteredBy
}
if ($DueAt) { $payload['due_at'] = $DueAt }
else { $payload['due_in_minutes'] = (Convert-Duration -Text $DueIn) }

$json = $payload | ConvertTo-Json -Depth 8 -Compress

if ($DryRun) {
    Write-Host 'DRY RUN -- nothing was registered. Payload:'
    Write-Host ($payload | ConvertTo-Json -Depth 8)
    exit 0
}

# The payload goes over stdin, never inside the remote command string: a body
# containing a quote or a dollar sign is mangled by shell interpolation, and an
# evidence marker is exactly the kind of free text that contains both.
$remote = @'
set -e
TOKEN=$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN)
BODY=$(cat)
curl -sS -X POST http://localhost:3090/api/taskmaster/expectations \
  -H "x-archon-operator-token: $TOKEN" \
  -H 'content-type: application/json' \
  -w '\n%{http_code}' \
  --data-binary "$BODY"
'@

$response = $json | ssh $SshHost $remote
$lines = $response -split "`n"
$status = $lines[-1].Trim()
$responseBody = ($lines[0..($lines.Count - 2)] -join "`n").Trim()

if ($status -ne '200') {
    Write-Error "Registration failed (HTTP $status): $responseBody"
    exit 1
}

$result = $responseBody | ConvertFrom-Json
if ($result.created) {
    Write-Host "Registered expectation $($result.id)"
} else {
    # NOT a silent success. The effective deadline is the FIRST registration's,
    # so a caller that assumes it just bought 24 hours may have bought none.
    Write-Host "Expectation already existed under this key: $($result.id)"
    Write-Host 'The deadline below is the ORIGINAL one, not the one you just asked for.'
}
Write-Host "  recipient:  $Recipient"
Write-Host "  evidence:   $Evidence"
Write-Host "  due at:     $($result.due_at)"
Write-Host "  on absence: $($result.on_absence)"
if ($result.self_supervised) {
    Write-Host '  NOTE: self-supervised (registrant is the recipient).'
}
