# CloudKit Journal

An iOS-first Expo development app for the Party Stack CloudKit ontology backend. iOS uses native `CKDatabase`; web uses CloudKit Web Services.

## Local setup

1. Copy `.env.example` to `.env.local` and choose a unique bundle and iCloud container identifier.
2. Install and generate the declarative CloudKit schema:

   ```sh
   pnpm install --filter @party-stack/cloudkit-journal
   pnpm --filter @party-stack/cloudkit-journal cloudkit:schema
   ```

3. In [Apple Developer Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list):
   - Register an App ID with bundle ID `com.partystack.journal`.
   - Register the iCloud container `iCloud.com.partystack.journal`.
   - Edit the App ID, enable iCloud with CloudKit support, and associate that container.

   No Expo account is required. The `@party-stack/cloudkit-client-expo` config plugin writes the matching local entitlements during `expo prebuild`.
4. Create a CloudKit management token in CloudKit Console, then run:

   ```sh
   pnpm --filter @party-stack/cloudkit-journal cloudkit:setup
   ```

   The interactive setup validates and optionally imports `cloudkit-schema.ckdb` into the development environment. Tokens are saved to Keychain by Apple’s `cktool` and are never written to the repository.
5. Open the iOS Simulator, sign into a dedicated iCloud test account, and enable iCloud Drive.
6. Sign into your Apple Developer account in Xcode, select your team for the generated app target if prompted, and build the custom development client:

   ```sh
   pnpm --filter @party-stack/cloudkit-journal ios
   ```

Expo Go is not supported because the app includes a custom Swift module.

## Web setup

Create a web API token in CloudKit Console, configure its allowed origins and callback URL, and set `EXPO_PUBLIC_CLOUDKIT_API_TOKEN`. The HTTP client accepts an injected web-auth token provider; the demo captures `ckWebAuthToken` or `ckSession` from the callback URL.

## Environments

Simulator and local Xcode development builds use the CloudKit development environment. Deploy the schema to production in CloudKit Console before distributing through TestFlight or the App Store.
