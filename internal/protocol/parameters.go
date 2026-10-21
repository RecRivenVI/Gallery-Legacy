package protocol

import (
	"net/url"
	"strings"
	"unicode/utf8"
)

// Parameters follows URLSearchParams: plus is a space, malformed percent
// sequences remain literal, and each invalid UTF-8 sequence is replaced.
func Parameters(raw string) url.Values {
	params := url.Values{}
	for _, part := range strings.Split(strings.TrimPrefix(raw, "?"), "&") {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		params.Add(decodeParameter(key), decodeParameter(value))
	}
	return params
}

func hexDigit(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	default:
		return 0, false
	}
}

func decodeParameter(value string) string {
	var raw strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '+' {
			raw.WriteByte(' ')
			continue
		}
		if value[i] == '%' && i+2 < len(value) {
			a, okA := hexDigit(value[i+1])
			b, okB := hexDigit(value[i+2])
			if okA && okB {
				raw.WriteByte(a<<4 | b)
				i += 2
				continue
			}
		}
		raw.WriteByte(value[i])
	}
	bytes := raw.String()
	if utf8.ValidString(bytes) {
		return bytes
	}
	var text strings.Builder
	for len(bytes) > 0 {
		r, n := utf8.DecodeRuneInString(bytes)
		if r == utf8.RuneError && n == 1 {
			n = invalidPrefixLength(bytes)
		}
		text.WriteRune(r)
		bytes = bytes[n:]
	}
	return text.String()
}

// WHATWG UTF-8 consumes a valid prefix of an incomplete sequence together,
// but reprocesses an out-of-range continuation as a new invalid byte.
func invalidPrefixLength(value string) int {
	first := value[0]
	length, low, high := 1, byte(0x80), byte(0xbf)
	switch {
	case first >= 0xc2 && first <= 0xdf:
		length = 2
	case first >= 0xe0 && first <= 0xef:
		length = 3
		if first == 0xe0 {
			low = 0xa0
		}
		if first == 0xed {
			high = 0x9f
		}
	case first >= 0xf0 && first <= 0xf4:
		length = 4
		if first == 0xf0 {
			low = 0x90
		}
		if first == 0xf4 {
			high = 0x8f
		}
	}
	n := 1
	for n < length && n < len(value) {
		if value[n] < low || value[n] > high {
			break
		}
		n++
		low, high = 0x80, 0xbf
	}
	return n
}
