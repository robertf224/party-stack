---
"@party-stack/ontology-spec": minor
"@party-stack/ontology-backend": patch
"@party-stack/foundry-ontology": minor
---

Carry list size constraints on list types. `o.list({ elementType, size: { min, max } })` takes optional inclusive item-count bounds (non-negative integers, `min <= max`); a list without `size` is unconstrained, and existing definitions decode and hash exactly as before. `validate` rejects negative, fractional or inverted bounds.

Runtime and generated Effect schemas enforce the bounds through `isListSize` ("Enter between 1 and 3 items."). Owned backends report a check's own message in validation issues instead of the generic "Enter a valid value." when it has one.

Foundry action parameters fill the size from the public API's `validation.defaultValidation.arraySize` (`gte` to `min`, `lte` to `max`).
