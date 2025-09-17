#!/bin/bash

# Release validation script

set -e

echo "🔍 Validating release readiness..."

# Check required files
echo "✓ Checking required files..."
[ -f "package.json" ] || (echo "❌ Missing package.json" && exit 1)
[ -f "README.md" ] || (echo "❌ Missing README.md" && exit 1)
[ -f "LICENSE" ] || (echo "❌ Missing LICENSE" && exit 1)
[ -f "tsconfig.json" ] || (echo "❌ Missing tsconfig.json" && exit 1)
[ -d "src" ] || (echo "❌ Missing src directory" && exit 1)
[ -d "test" ] || (echo "❌ Missing test directory" && exit 1)

# Build project
echo "✓ Building project..."
npm run build

# Check build output
echo "✓ Checking build output..."
[ -f "dist/index.js" ] || (echo "❌ Missing dist/index.js" && exit 1)
[ -f "dist/index.d.ts" ] || (echo "❌ Missing dist/index.d.ts" && exit 1)

# Check package size
echo "✓ Checking package size..."
SIZE=$(npm pack --dry-run 2>&1 | grep "package size:" | cut -d':' -f2 | xargs)
echo "  Package size: $SIZE"

# Run basic tests
echo "✓ Running contract tests..."
npm run test:contract

echo ""
echo "✅ Release validation complete!"
echo ""
echo "Next steps:"
echo "1. Update version in package.json"
echo "2. Commit all changes"
echo "3. Create git tag: git tag v1.0.0"
echo "4. Push to GitHub: git push origin main --tags"
echo "5. Publish to npm: npm publish"