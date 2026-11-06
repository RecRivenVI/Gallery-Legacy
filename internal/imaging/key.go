package imaging

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
)

// Key names the observed source facts, never a machine path or catalog row ID.
func Key(platform, relative string, size, mtime int64, tier string) string {
	data, _ := json.Marshal([]string{"preview-v1", platform, strings.ToLower(strings.ReplaceAll(relative, `\`, "/")), strconv.FormatInt(size, 10), strconv.FormatInt(mtime, 10), tier})
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
