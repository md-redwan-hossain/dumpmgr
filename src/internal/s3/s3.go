package s3

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
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

func NewClient(opts config.S3Options, secretAccessKey string) (*s3.Client, error) {
	endpoint, _ := endpointFor(opts)
	region := opts.Region
	if region == "" {
		region = "us-east-1"
	}
	cfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(opts.AccessKey, secretAccessKey, ""),
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.UsePathStyle = opts.ForcePathStyle
	})
	return client, nil
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
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: aws.String(opts.BucketName),
	})
	var objects []Object
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Contents {
			if item.Key == nil {
				continue
			}
			key := *item.Key
			if !strings.HasSuffix(key, ".dump") && !strings.HasSuffix(key, ".dump.enc") {
				continue
			}
			var lm *time.Time
			if item.LastModified != nil {
				t := *item.LastModified
				lm = &t
			}
			size := int64(0)
			if item.Size != nil {
				size = *item.Size
			}
			objects = append(objects, Object{
				Key:          key,
				Size:         size,
				LastModified: lm,
			})
		}
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

func Upload(ctx context.Context, client *s3.Client, bucket, dumpsRoot, filePath string) (string, error) {
	key, err := ObjectKey(dumpsRoot, filePath)
	if err != nil {
		return "", err
	}
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	_, err = client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Body:   f,
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

func Download(ctx context.Context, client *s3.Client, bucket, dumpsRoot, key string) (string, error) {
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
	out, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(safe),
	})
	if err != nil {
		return "", err
	}
	defer out.Body.Close()
	f, err := os.Create(localPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(f, out.Body); err != nil {
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
