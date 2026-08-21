#!/usr/bin/env bash
# Removes Co-authored-by and Signed-off-by lines from the last N commits,
# preserving only lines that reference github-actions[bot].
#
# Usage:
#   ./clean-commit-authors.sh [N] [DIR]
#
# Arguments:
#   N    Number of commits to scan/rewrite from HEAD (default: 8)
#   DIR  Path to the git repository to operate on (default: current directory)
#
# Examples:
#   ./clean-commit-authors.sh
#   ./clean-commit-authors.sh 5
#   ./clean-commit-authors.sh 8 /path/to/repo
#   ./clean-commit-authors.sh 5 ../maintained-actions/add-and-commit
#
# After running, force-push if the branch has a remote:
#   git push --force-with-lease

set -euo pipefail

N=${1:-8}
DIR=${2:-.}

# Resolve to absolute path
DIR=$(cd "$DIR" && pwd)

if [ ! -d "$DIR/.git" ]; then
    echo "Error: '$DIR' is not a git repository" >&2
    exit 1
fi

CURRENT_BRANCH=$(git -C "$DIR" rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "auto-cherry-pick" ]; then
    echo "Error: expected branch 'auto-cherry-pick', currently on '$CURRENT_BRANCH'" >&2
    echo "Switch with: git -C \"$DIR\" checkout auto-cherry-pick" >&2
    exit 1
fi

echo "Repository : $DIR"
echo "Branch     : $CURRENT_BRANCH"

echo "Pulling latest changes..."
git -C "$DIR" pull --rebase

TOTAL=$(git -C "$DIR" rev-list --count HEAD)
if [ "$N" -gt "$TOTAL" ]; then
    echo "Error: only $TOTAL commits exist, cannot process $N" >&2
    exit 1
fi

# GIT_SEQUENCE_EDITOR: marks every 'pick' line as 'reword' so git rewrites each message.
SEQ_SCRIPT=$(mktemp /tmp/seq-editor-XXXXXX.py)
# GIT_EDITOR: called by git for each commit message — filters the file in place.
MSG_SCRIPT=$(mktemp /tmp/msg-editor-XXXXXX.py)
trap 'rm -f "$SEQ_SCRIPT" "$MSG_SCRIPT"' EXIT

cat > "$SEQ_SCRIPT" << 'PYEOF'
#!/usr/bin/env python3
import sys, re

with open(sys.argv[1]) as f:
    content = f.read()

content = re.sub(r'^pick ', 'reword ', content, flags=re.MULTILINE)

with open(sys.argv[1], 'w') as f:
    f.write(content)
PYEOF

cat > "$MSG_SCRIPT" << 'PYEOF'
#!/usr/bin/env python3
import sys, re

with open(sys.argv[1]) as f:
    msg = f.read()

lines = msg.split('\n')
filtered = []

for line in lines:
    if re.match(r'^(Co-authored-by:|Signed-off-by:)\s+', line, re.IGNORECASE):
        if 'github-actions[bot]' not in line.lower():
            continue
    filtered.append(line)

while filtered and not filtered[-1].strip():
    filtered.pop()

with open(sys.argv[1], 'w') as f:
    f.write('\n'.join(filtered) + '\n')
PYEOF

chmod +x "$SEQ_SCRIPT" "$MSG_SCRIPT"

echo "Rewriting last $N commits — keeping only github-actions[bot] attribution..."

GIT_SEQUENCE_EDITOR="python3 $SEQ_SCRIPT" GIT_EDITOR="python3 $MSG_SCRIPT" \
    git -C "$DIR" rebase -i "HEAD~$N"

echo "Done. $N commits cleaned."
echo ""
echo "If this branch has a remote tracking branch, run:"
echo "  git -C \"$DIR\" push --force-with-lease"
