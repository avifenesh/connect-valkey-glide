const { GlideClient } = require('@valkey/valkey-glide');

async function waitForValkey() {
  const maxRetries = 60;
  const retryDelay = 2000;

  console.log('Waiting for Valkey to be ready...');

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Test standalone connection
      const client = await GlideClient.createClient({
        addresses: [{ host: 'localhost', port: 6379 }],
        requestTimeout: 5000,
      });

      await client.ping();
      await client.close();

      console.log(`✓ Valkey standalone ready after ${i + 1} attempts`);

      // Test cluster connection (with more retries as cluster takes longer)
      if (i > 10) { // Give cluster more time to initialize
        try {
          const { GlideClusterClient } = require('@valkey/valkey-glide');
          const clusterClient = await GlideClusterClient.createClient({
            addresses: [
              { host: 'localhost', port: 7001 },
              { host: 'localhost', port: 7002 },
              { host: 'localhost', port: 7003 },
            ],
            requestTimeout: 5000,
          });

          await clusterClient.ping();
          await clusterClient.close();
          console.log('✓ Valkey cluster ready');
        } catch (clusterError) {
          console.log('⚠ Cluster not ready yet, continuing with standalone...');
        }
      }

      console.log('✓ Valkey infrastructure is ready for testing');
      return;
    } catch (error) {
      if (i === maxRetries - 1) {
        console.error(`✗ Valkey not ready after ${maxRetries} attempts:`);
        console.error(error.message);
        process.exit(1);
      }

      if (i % 10 === 0) {
        console.log(`Attempt ${i + 1}/${maxRetries} - Still waiting...`);
      }

      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

waitForValkey().catch(error => {
  console.error('Failed to wait for Valkey:', error);
  process.exit(1);
});