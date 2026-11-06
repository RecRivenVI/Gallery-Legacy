package personal

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/google/uuid"
)

func password(value string) (string, string, error) {
	if value == "" {
		return "", "", nil
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", "", fmt.Errorf("create password salt: %w", err)
	}
	key, err := pbkdf2.Key(sha256.New, value, salt, 120000, 32)
	if err != nil {
		return "", "", fmt.Errorf("derive password: %w", err)
	}
	return hex.EncodeToString(salt), hex.EncodeToString(key), nil
}
func (s *Store) Accounts(ctx context.Context) ([]api.Account, error) {
	rows, err := s.DB.QueryContext(ctx, "SELECT id,name,avatar,password_hash!='' FROM accounts ORDER BY created_at,id")
	if err != nil {
		return nil, fmt.Errorf("list local accounts: %w", err)
	}
	defer rows.Close()
	result := []api.Account{}
	for rows.Next() {
		var a api.Account
		if err = rows.Scan(&a.ID, &a.Name, &a.Avatar, &a.HasPassword); err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}
func (s *Store) Create(ctx context.Context, name, secret string, prefs json.RawMessage) (api.Account, error) {
	a := api.Account{ID: uuid.NewString(), Name: strings.TrimSpace(name), HasPassword: secret != ""}
	if a.Name == "" {
		return a, failure("ACCOUNT_NAME_REQUIRED")
	}
	salt, hash, err := password(secret)
	if err != nil {
		return a, err
	}
	if len(prefs) == 0 {
		prefs = json.RawMessage(`{}`)
	}
	if !json.Valid(prefs) {
		return a, failure("INVALID_BODY")
	}
	_, err = s.DB.ExecContext(ctx, "INSERT INTO accounts(id,name,password_salt,password_hash,preferences,created_at) VALUES(?,?,?,?,?,?)", a.ID, a.Name, salt, hash, string(prefs), time.Now().UnixMilli())
	if err != nil {
		return a, fmt.Errorf("create local account: %w", err)
	}
	return a, nil
}
func (s *Store) Login(ctx context.Context, id, secret string) (string, error) {
	var salt, hash string
	err := s.DB.QueryRowContext(ctx, "SELECT password_salt,password_hash FROM accounts WHERE id=?", id).Scan(&salt, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", failure("ACCOUNT_NOT_FOUND")
	}
	if err != nil {
		return "", fmt.Errorf("read local credential: %w", err)
	}
	if hash != "" {
		raw, err := hex.DecodeString(salt)
		if err != nil {
			return "", fmt.Errorf("read password salt: %w", err)
		}
		key, err := pbkdf2.Key(sha256.New, secret, raw, 120000, 32)
		if err != nil {
			return "", err
		}
		if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(key)), []byte(hash)) != 1 {
			return "", failure("PASSWORD_INCORRECT")
		}
	}
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		return "", err
	}
	value := hex.EncodeToString(token)
	err = s.transaction(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "INSERT INTO sessions VALUES(?,?,?)", value, id, time.Now().AddDate(1, 0, 0).UnixMilli()); err != nil {
			return fmt.Errorf("insert local session: %w", err)
		}
		_, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at<?", time.Now().UnixMilli())
		if err != nil {
			return fmt.Errorf("expire local sessions: %w", err)
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("create local session: %w", err)
	}
	return value, nil
}
func (s *Store) Session(ctx context.Context, token string) (*api.Account, error) {
	if token == "" {
		return nil, nil
	}
	var a api.Account
	err := s.DB.QueryRowContext(ctx, "SELECT a.id,a.name,a.avatar,a.password_hash!='' FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token=? AND s.expires_at>?", token, time.Now().UnixMilli()).Scan(&a.ID, &a.Name, &a.Avatar, &a.HasPassword)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read local session: %w", err)
	}
	return &a, nil
}
func (s *Store) Logout(ctx context.Context, token string) error {
	_, err := s.DB.ExecContext(ctx, "DELETE FROM sessions WHERE token=?", token)
	if err != nil {
		return fmt.Errorf("end local session: %w", err)
	}
	return nil
}
func (s *Store) Update(ctx context.Context, id, name, avatar string, secret *string) error {
	if strings.TrimSpace(name) == "" {
		return failure("ACCOUNT_NAME_REQUIRED")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE accounts SET name=?,avatar=? WHERE id=?", strings.TrimSpace(name), avatar, id); err != nil {
			return fmt.Errorf("update account: %w", err)
		}
		if secret != nil {
			return setPassword(ctx, tx, id, *secret)
		}
		return nil
	})
}
func setPassword(ctx context.Context, tx *sql.Tx, id, value string) error {
	salt, hash, err := password(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE accounts SET password_salt=?,password_hash=? WHERE id=?", salt, hash, id)
	if err != nil {
		return fmt.Errorf("change account password: %w", err)
	}
	return nil
}
func (s *Store) ResetPassword(ctx context.Context, id, value string) error {
	return s.transaction(ctx, func(tx *sql.Tx) error { return setPassword(ctx, tx, id, value) })
}
func (s *Store) Delete(ctx context.Context, id string) error {
	_, err := s.DB.ExecContext(ctx, "DELETE FROM accounts WHERE id=?", id)
	if err != nil {
		return fmt.Errorf("delete account: %w", err)
	}
	return nil
}
func (s *Store) Preferences(ctx context.Context, id string) (json.RawMessage, error) {
	var value string
	err := s.DB.QueryRowContext(ctx, "SELECT preferences FROM accounts WHERE id=?", id).Scan(&value)
	if err != nil {
		return nil, fmt.Errorf("read account preferences: %w", err)
	}
	return json.RawMessage(value), nil
}
func (s *Store) SavePreferences(ctx context.Context, id string, value json.RawMessage) error {
	var prefs map[string]json.RawMessage
	if err := json.Unmarshal(value, &prefs); err != nil || prefs == nil {
		return failure("INVALID_BODY")
	}
	_, err := s.DB.ExecContext(ctx, "UPDATE accounts SET preferences=? WHERE id=?", string(value), id)
	if err != nil {
		return fmt.Errorf("save account preferences: %w", err)
	}
	return nil
}
