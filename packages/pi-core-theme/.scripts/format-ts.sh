#!/usr/bin/env bash
# Format TypeScript/TSX files using the external editor formatter.
#
# Usage:
#   bash .scripts/format-ts.sh
#   bash .scripts/format-ts.sh src test
#
# Default root: repository root

set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node_bin="/opt/homebrew/bin/node"
formatter="$HOME/.config/editor-format/format.mjs"

if [ ! -x "$node_bin" ]; then
    echo "format-ts: node not found or not executable: $node_bin" >&2
    exit 1
fi

if [ ! -f "$formatter" ]; then
    echo "format-ts: formatter not found: $formatter" >&2
    exit 1
fi

if [ "$#" -eq 0 ]; then
    roots=("$repo_root")
else
    roots=("$@")
fi

list="$(mktemp)"
out="$(mktemp)"

cleanup() {
    rm -f "$list" "$out"
}

trap cleanup EXIT INT TERM

find "${roots[@]}" \
    -type f \
    \( -name '*.ts' -o -name '*.tsx' \) \
    -not -path '*/node_modules/*' \
    -not -path '*/dist/*' \
    -not -path '*/build/*' \
    -print0 >"$list"

total="$(tr -cd '\0' <"$list" | wc -c | tr -d '[:space:]')"

if [ "$total" -eq 0 ]; then
    echo "format-ts: no .ts/.tsx files under ${roots[*]}"
    exit 0
fi

echo "format-ts: scanning $total file(s) under ${roots[*]}"

if [ -t 2 ]; then
    step=1
else
    step=$((total / 10))
    if [ "$step" -lt 1 ]; then
        step=1
    fi
fi

abspath() {
    if command -v realpath >/dev/null 2>&1; then
        realpath "$1"
    else
        printf '%s/%s\n' \
            "$(cd "$(dirname "$1")" && pwd -P)" \
            "$(basename "$1")"
    fi
}

index=0
changed=0
unchanged=0
failed=0

while IFS= read -r -d '' file; do
    index=$((index + 1))

    case "$file" in
    *.tsx)
        mode="typescriptreact"
        ;;
    *.ts)
        mode="typescript"
        ;;
    *)
        continue
        ;;
    esac

    abs="$(abspath "$file")"

    if "$node_bin" "$formatter" "$mode" "$abs" <"$file" >"$out"; then
        if cmp -s "$out" "$file"; then
            unchanged=$((unchanged + 1))
        else
            cat "$out" >"$file"
            changed=$((changed + 1))
            echo "format-ts: formatted $file" >&2
        fi
    else
        failed=$((failed + 1))
        echo "format-ts: FAILED $file" >&2
    fi

    if [ -t 2 ]; then
        printf '\rformat-ts: %d/%d' "$index" "$total" >&2
    elif [ $((index % step)) -eq 0 ]; then
        echo "format-ts: progress $index/$total" >&2
    fi
done <"$list"

if [ -t 2 ]; then
    printf '\r\033[K' >&2
fi

echo "format-ts: ${changed} changed, ${unchanged} unchanged, ${failed} failed (${total} scanned)"

[ "$failed" -eq 0 ]
