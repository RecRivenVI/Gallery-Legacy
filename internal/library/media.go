package library

import "strings"

// MediaKind is physical eligibility, not a metadata declaration.
func MediaKind(ext string) string {
	ext = strings.ToLower(strings.TrimPrefix(ext, "."))
	if strings.Contains("|avif|bmp|gif|ico|jpeg|jpg|png|svg|tif|tiff|webp|", "|"+ext+"|") {
		return "image"
	}
	if strings.Contains("|avi|m4v|mkv|mov|mp4|ogv|webm|", "|"+ext+"|") {
		return "video"
	}
	return ""
}
