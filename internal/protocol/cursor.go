package protocol

import "encoding/base64"

func EncodeCursor(position map[string]string, key string, revision *int64) (*string, error) {
	if position == nil {
		return nil, nil
	}
	type orderedPosition struct {
		Value    *string `json:"value,omitempty"`
		WorkID   string  `json:"workId,omitempty"`
		AuthorID string  `json:"authorId,omitempty"`
		TagID    string  `json:"tagId,omitempty"`
	}
	p := orderedPosition{WorkID: position["workId"], AuthorID: position["authorId"], TagID: position["tagId"]}
	if value, ok := position["value"]; ok {
		p.Value = &value
	}
	value := struct {
		Version  int             `json:"v"`
		Key      string          `json:"key"`
		Position orderedPosition `json:"position"`
		Revision *int64          `json:"revision"`
	}{1, key, p, revision}
	bytes, err := stringify(value)
	if err != nil {
		return nil, err
	}
	encoded := base64.RawURLEncoding.EncodeToString(bytes)
	return &encoded, nil
}
