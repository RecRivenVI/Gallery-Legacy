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

// ArchiveExtensions is the fixed file-category rule, independent of platform metadata.
func ArchiveExtensions() []string {
	return strings.Split("zip rar 7z tar gz bz2 xz tgz tbz tbz2 txz zst lz lz4 cab cbz cbr cb7", " ")
}
func IsArchive(ext string) bool {
	ext = strings.ToLower(strings.TrimPrefix(ext, "."))
	for _, supported := range ArchiveExtensions() {
		if ext == supported {
			return true
		}
	}
	return false
}
