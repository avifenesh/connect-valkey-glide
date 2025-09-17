# CI Documentation

## Test Execution

The project uses GitHub Actions for continuous integration.

### Running Tests Locally

```bash
# All tests
npm test

# Specific test suites
npm run test:contract      # API compatibility tests
npm run test:integration  # Integration tests
npm run test:e2e          # End-to-end tests

# Mode-specific tests
npm run test:standalone   # Standalone mode only
npm run test:cluster      # Cluster mode only
```

### CI Jobs

- **lint-and-build**: Code quality checks
- **test-contract**: API contract validation
- **test-standalone**: Standalone Valkey tests
- **test-cluster**: Cluster mode tests
- **security**: Dependency audit

### Test Infrastructure

- Standalone: Uses Docker container on port 6379
- Cluster: Uses docker-compose with ports 8001-8003

### Troubleshooting

If tests fail locally:
1. Ensure Docker is running
2. Check port availability (6379 for standalone, 8001-8003 for cluster)
3. Clean up with: `npm run clean`