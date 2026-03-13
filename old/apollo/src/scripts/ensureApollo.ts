import * as Apollo from "../Apollo.js";

async function ensureApollo(): Promise<string> {
    return Apollo.ensureBinary({
        apolloUrl: process.argv[2]!,
        clientId: process.argv[3]!,
        clientSecret: process.argv[4]!,
    });
}

ensureApollo()
    .then((apolloPath) => {
        console.log(apolloPath);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
