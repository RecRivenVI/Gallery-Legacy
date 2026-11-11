package instance

import (
	"crypto/sha256"
	"encoding/hex"
)

func AccessClientID(instanceID, address string) string {
	sum := sha256.Sum256([]byte(instanceID + "\x00" + address))
	return hex.EncodeToString(sum[:8])
}
