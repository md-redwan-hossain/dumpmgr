package s3

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type Object struct {
	Key          string
	Size         int64
	LastModified *time.Time
}

func endpointFor(opts config.S3Options) (string, bool) {
	endpoint := strings.TrimRight(opts.Endpoint, "/")
	if strings.Contains(endpoint, "://") {
		if opts.UseHTTPS {
			endpoint = strings.Replace(endpoint, "http://", "https://", 1)
		} else {
			endpoint = strings.Replace(endpoint, "https://", "http://", 1)
		}
		return endpoint, opts.UseHTTPS
	}
	if opts.UseHTTPS {
		return "https://" + endpoint, true
	}
	return "http://" + endpoint, false
}

func NewClient(opts config.S3Options, secretAccessKey string) (*minio.Client, error) {
	endpoint, secure := endpointFor(opts)
	region := opts.Region
	if region == "" {
		region = "us-east-1"
	}
	lookup := minio.BucketLookupAuto
	if opts.ForcePathStyle {
		lookup = minio.BucketLookupPath
	}
	return minio.New(endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(opts.AccessKey, secretAccessKey, ""),
		Secure:       secure,
		Region:       region,
		BucketLookup: lookup,
	})
}

func ObjectKey(dumpsRoot, filePath string) (string, error) {
	root, err := filepath.Abs(dumpsRoot)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(filePath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == "" || strings.HasPrefix(rel, "..") || strings.Contains(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("selected dump must be inside the configured dumps directory")
	}
	return filepath.ToSlash(rel), nil
}

func safeObjectKey(key string) (string, error) {
	normalized := strings.TrimLeft(strings.ReplaceAll(key, "\\", "/"), "/")
	parts := strings.Split(normalized, "/")
	for _, part := range parts {
		if part == ".." || part == "." {
			return "", fmt.Errorf("unsafe S3 object key: %s", key)
		}
	}
	if normalized == "" {
		return "", fmt.Errorf("unsafe S3 object key: %s", key)
	}
	return normalized, nil
}

func LocalPathForObject(dumpsRoot, key string) (string, error) {
	safe, err := safeObjectKey(key)
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(dumpsRoot)
	if err != nil {
		return "", err
	}
	path := filepath.Join(root, filepath.FromSlash(safe))
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if abs != root && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return "", fmt.Errorf("S3 object would download outside the dumps directory")
	}
	return abs, nil
}

func ListObjects(ctx context.Context, opts config.S3Options, secretAccessKey string) ([]Object, error) {
	client, err := NewClient(opts, secretAccessKey)
	if err != nil {
		return nil, err
	}
	ch := client.ListObjects(ctx, opts.BucketName, minio.ListObjectsOptions{Recursive: true})
	var objects []Object
	for item := range ch {
		if item.Err != nil {
			return nil, item.Err
		}
		if !strings.HasSuffix(item.Key, ".dump") && !strings.HasSuffix(item.Key, ".dump.enc") {
			continue
		}
		var lm *time.Time
		if !item.LastModified.IsZero() {
			t := item.LastModified
			lm = &t
		}
		objects = append(objects, Object{
			Key:          item.Key,
			Size:         item.Size,
			LastModified: lm,
		})
	}
	sort.Slice(objects, func(i, j int) bool {
		return objects[i].Key > objects[j].Key
	})
	return objects, nil
}

func VerifyBucket(ctx context.Context, opts config.S3Options, secretAccessKey string) error {
	_, err := ListObjects(ctx, opts, secretAccessKey)
	if err != nil && opts.CreateBucketIfNotExists {
		return fmt.Errorf(`cannot access S3 bucket %q. Bucket creation is not supported automatically; create it first or disable createBucketIfNotExists: %w`,
			opts.BucketName, err)
	}
	return err
}

func Upload(ctx context.Context, client *minio.Client, bucket, dumpsRoot, filePath string) (string, error) {
	key, err := ObjectKey(dumpsRoot, filePath)
	if err != nil {
		return "", err
	}
	_, err = client.FPutObject(ctx, bucket, key, filePath, minio.PutObjectOptions{})
	if err != nil {
		return "", err
	}
	return key, nil
}

func Download(ctx context.Context, client *minio.Client, bucket, dumpsRoot, key string) (string, error) {
	safe, err := safeObjectKey(key)
	if err != nil {
		return "", err
	}
	localPath, err := LocalPathForObject(dumpsRoot, safe)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return "", err
	}
	if err := client.FGetObject(ctx, bucket, safe, localPath, minio.GetObjectOptions{}); err != nil {
		return "", err
	}
	return localPath, nil
}

func FormatObject(obj Object) string {
	date := ""
	if obj.LastModified != nil {
		date = " " + obj.LastModified.UTC().Format(time.RFC3339)
	}
	base := filepath.Base(obj.Key)
	return fmt.Sprintf("%s (%d B)%s", base, obj.Size, date)
}

func ParseEndpointHost(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err == nil && u.Host != "" {
		return u.Host
	}
	return strings.TrimPrefix(strings.TrimPrefix(endpoint, "https://"), "http://")
}
