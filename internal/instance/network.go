package instance

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/net/idna"
)

var hostProfile = idna.New(idna.MapForLookup(), idna.StrictDomainName(false), idna.VerifyDNSLength(false))

func configureNetwork(config *Config, source map[string]any) error {
	properties, err := defaults()
	if err != nil {
		return err
	}
	config.Mode = stringOr(source["mode"], properties["mode"]["default"].(string))
	config.Host = stringOr(source["listenAddress"], stringOr(source["host"], properties["host"]["default"].(string)))
	port := source["port"]
	if port == nil {
		port = properties["port"]["default"]
	}
	n, ok := port.(float64)
	if !ok || n < 1 || n > 65535 || math.Trunc(n) != n {
		return fmt.Errorf("PORT_INVALID")
	}
	config.Port = int(n)
	ip := net.ParseIP(config.Host)
	loopback := config.Host == "127.0.0.1" || config.Host == "::1"
	lan := ip != nil && ip.To4() != nil && !strings.Contains(config.Host, ":") && (ip[12] == 10 || ip[12] == 192 && ip[13] == 168 || ip[12] == 172 && ip[13] >= 16 && ip[13] <= 31)
	if !slices.Contains([]string{"local", "lan", "public"}, config.Mode) || config.Mode != "public" && !loopback && (config.Mode != "lan" || !lan) || config.Mode == "public" && (ip == nil || !nonemptyArray(source["allowedHosts"])) {
		return fmt.Errorf("LISTEN_ADDRESS_FORBIDDEN")
	}
	host := config.Host
	if host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if host == "::" {
		host = "::1"
	}
	config.URL = "http://" + net.JoinHostPort(host, strconv.Itoa(config.Port))
	config.LocalHosts = []string{"localhost:" + strconv.Itoa(config.Port), "127.0.0.1:" + strconv.Itoa(config.Port), "[::1]:" + strconv.Itoa(config.Port)}
	connectAuthority, err := authority(net.JoinHostPort(host, strconv.Itoa(config.Port)))
	if err != nil {
		return err
	}
	config.AllowedHosts = []string{connectAuthority}
	for _, value := range config.LocalHosts {
		if !slices.Contains(config.AllowedHosts, value) {
			config.AllowedHosts = append(config.AllowedHosts, value)
		}
	}
	if raw, exists := source["allowedHosts"]; exists {
		entries, ok := raw.([]any)
		if !ok {
			return fmt.Errorf("ALLOWED_HOST_INVALID")
		}
		for _, value := range entries {
			text, ok := value.(string)
			if !ok {
				return fmt.Errorf("ALLOWED_HOST_INVALID")
			}
			authority, err := authority(text)
			if err != nil {
				return fmt.Errorf("ALLOWED_HOST_INVALID: %w", err)
			}
			if !slices.Contains(config.AllowedHosts, authority) {
				config.AllowedHosts = append(config.AllowedHosts, authority)
			}
		}
	}
	return configureOrigins(config, source)
}
func nonemptyArray(value any) bool { v, ok := value.([]any); return ok && len(v) > 0 }

func configureOrigins(config *Config, source map[string]any) error {
	config.AllowedOrigins = []string{}
	if value := source["allowedOrigins"]; !truthy(value) {
		for _, host := range config.AllowedHosts {
			config.AllowedOrigins = append(config.AllowedOrigins, "http://"+host)
		}
	} else {
		values, ok := value.([]any)
		if !ok {
			return fmt.Errorf("ALLOWED_ORIGIN_INVALID")
		}
		for _, value := range values {
			origin, ok := value.(string)
			if !ok {
				return fmt.Errorf("ALLOWED_ORIGIN_INVALID")
			}
			config.AllowedOrigins = append(config.AllowedOrigins, origin)
		}
	}
	for _, origin := range config.AllowedOrigins {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("ALLOWED_ORIGIN_INVALID")
		}
		host, err := authorityFor(u.Host, u.Scheme)
		if err != nil || u.Scheme+"://"+host != origin || !slices.Contains(config.AllowedHosts, strings.ToLower(host)) {
			return fmt.Errorf("ALLOWED_ORIGIN_INVALID")
		}
	}
	config.PublicURL = stringOr(source["publicUrl"], config.URL)
	if !slices.Contains(config.AllowedOrigins, config.PublicURL) {
		return fmt.Errorf("PUBLIC_URL_INVALID")
	}
	return nil
}

func authority(value string) (string, error) { return authorityFor(value, "http") }
func authorityFor(value, scheme string) (string, error) {
	if value == "" || strings.ContainsAny(value, "/\\@?#") || strings.ContainsFunc(value, unicode.IsSpace) {
		return "", fmt.Errorf("invalid authority")
	}
	u, err := url.Parse(scheme + "://" + value)
	if err != nil || u.User != nil || u.Hostname() == "" {
		return "", fmt.Errorf("invalid authority")
	}
	host := strings.ToLower(u.Hostname())
	if ip := net.ParseIP(host); ip != nil {
		if strings.Contains(host, ":") {
			host = "[" + ipv6Host(ip) + "]"
		} else {
			host = ip.String()
		}
	} else {
		host, err = hostProfile.ToASCII(host)
		if err != nil {
			return "", err
		}
		host, err = ipv4Host(host)
		if err != nil {
			return "", err
		}
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n > 65535 {
			return "", fmt.Errorf("invalid port")
		}
		if (scheme == "http" && n == 80) || (scheme == "https" && n == 443) {
			port = ""
		} else {
			port = strconv.Itoa(n)
		}
	}
	if port != "" {
		host += ":" + port
	}
	return host, nil
}

func ipv4Host(host string) (string, error) {
	parts := strings.Split(strings.TrimSuffix(host, "."), ".")
	last := parts[len(parts)-1]
	_, numeric := ipv4Number(last)
	if !numeric && !digitsOnly(last) {
		return host, nil
	}
	if len(parts) > 4 {
		return "", fmt.Errorf("invalid IPv4 host")
	}
	var address uint64
	for i, part := range parts {
		n, ok := ipv4Number(part)
		if !ok {
			return "", fmt.Errorf("invalid IPv4 host")
		}
		if i < len(parts)-1 {
			if n > 255 {
				return "", fmt.Errorf("invalid IPv4 host")
			}
			address = address<<8 | n
		} else {
			bits := 8 * (5 - len(parts))
			if n >= uint64(1)<<bits {
				return "", fmt.Errorf("invalid IPv4 host")
			}
			address = address<<bits | n
		}
	}
	return fmt.Sprintf("%d.%d.%d.%d", address>>24&255, address>>16&255, address>>8&255, address&255), nil
}
func digitsOnly(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
func ipv4Number(value string) (uint64, bool) {
	base := 10
	if strings.HasPrefix(value, "0x") || strings.HasPrefix(value, "0X") {
		base = 16
		value = value[2:]
	} else if len(value) > 1 && value[0] == '0' {
		base = 8
		value = value[1:]
	}
	if value == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(value, base, 32)
	return n, err == nil
}
func ipv6Host(ip net.IP) string {
	bytes := ip.To16()
	groups := make([]uint16, 8)
	for i := range groups {
		groups[i] = uint16(bytes[i*2])<<8 | uint16(bytes[i*2+1])
	}
	bestStart, bestLength := -1, 1
	for i := 0; i < 8; {
		if groups[i] != 0 {
			i++
			continue
		}
		end := i
		for end < 8 && groups[end] == 0 {
			end++
		}
		if end-i > bestLength {
			bestStart, bestLength = i, end-i
		}
		i = end
	}
	parts := []string{}
	for i := 0; i < 8; {
		if i == bestStart {
			parts = append(parts, "")
			if i == 0 {
				parts = append(parts, "")
			}
			i += bestLength
			if i == 8 {
				parts = append(parts, "")
			}
		} else {
			parts = append(parts, strconv.FormatUint(uint64(groups[i]), 16))
			i++
		}
	}
	return strings.Join(parts, ":")
}
