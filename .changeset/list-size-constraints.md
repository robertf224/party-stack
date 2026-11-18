---
"@party-stack/ontology-spec": minor
"@party-stack/ontology-backend": patch
"@party-stack/foundry-ontology": minor
---

Carry list size constraints on list types. `o.list({ elementType, size: { min, max } })` takes optional inclusive item-count bounds (non-negative integers, `min <= max`); a list without `size` is unconstrained, and existing definitions decode and hash exactly as before. `validate` rejects negative, fractional or inverted bounds.

Runtime and generated Effect schemas enforce the bounds ("Enter between 1 and 3 items."), and an empty list for a required (non-optional) action parameter now counts as missing ("A value is required."). Owned backends report these messages as validation issues, with code `required` for an empty required list.

Foundry action parameters fill the size from the public API's `validation.defaultValidation.arraySize` (`gte` to `min`, `lte` to `max`).
