# Publishing to npm

## Prerequisites
- npm account with publishing rights
- NPM token configured

## NPM Token Configuration

### Option 1: Using .npmrc (Recommended for CI/CD)
Create or update `~/.npmrc`:
```bash
//registry.npmjs.org/:_authToken=YOUR_NPM_TOKEN
```

### Option 2: Using npm login
```bash
npm login
```

### Option 3: Environment Variable
```bash
export NPM_TOKEN=YOUR_NPM_TOKEN
npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN
```

## Publishing Steps

1. **Ensure tests pass**:
   ```bash
   npm test
   ```

2. **Build the package**:
   ```bash
   npm run build
   ```

3. **Update version** (if needed):
   ```bash
   npm version patch  # or minor/major
   ```

4. **Publish to npm**:
   ```bash
   npm publish
   ```

## GitHub Actions CI/CD Publishing

To enable automated publishing via GitHub Actions:

1. Add the NPM token as a GitHub secret:
   - Go to Settings → Secrets and variables → Actions
   - Add new secret: `NPM_TOKEN`
   - Value: Your npm token (get from npm.com account settings)

2. The release workflow will automatically publish when:
   - A new tag is pushed
   - A release is created on GitHub

## Manual Publishing Checklist

- [ ] All tests passing
- [ ] Version bumped appropriately
- [ ] CHANGELOG.md updated
- [ ] README.md is current
- [ ] Build output verified
- [ ] Git tag created
- [ ] Changes pushed to GitHub

## Post-Publishing

After publishing:
1. Verify on npm: https://www.npmjs.com/package/connect-valkey-glide
2. Test installation: `npm install connect-valkey-glide`
3. Create GitHub release with changelog

---
**Security Note**: Never commit tokens directly to the repository. Use environment variables or GitHub secrets.