# Distribution decisions for this research pack

## Tatoeba learned associations

A supported implementation path is to distribute **aggregate, single-token association counts or learned alignment probabilities**, keeping raw parallel sentences in the research directory. Accompany the model with OPUS/Tatoeba attribution, the source-version/URL/hash manifest, the actual CC BY 2.0 FR license, and a statement identifying the transformation into aggregate statistics. Do not publish a sentence cache, corpus reconstruction API, or original sentence excerpts through this model artifact.

The bundled CC BY 2.0 FR legal text grants reuse, adaptation and distribution subject to attribution. Its attribution clause requires author/pseudonym and title when indicated, preservation of notices, source URI where practicable, and marking derived use. The OPUS Moses archive provides corpus-level notices, not individual author names or Tatoeba sentence IDs; retain the available notices and do not invent absent metadata. This is why the source pair JSON marks authors and original IDs as null. The text license has no noncommercial or share-alike restriction. [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/)

Numeric weights are not automatically exempt from source obligations. Whether particular learned parameters reproduce protected expression or implicate other database rights depends on their content and use. The practical approach here does not rely on an exemption: it preserves the available attribution/license and avoids exposing raw expressive texts. A minimum aggregate support threshold (such as five independent sentence groups) helps avoid a model becoming a one-example lookup table, but is an engineering measure, not a legal threshold. Creative Commons states that its licenses cover new technologies when their conditions are followed. [CC AI and licenses FAQ](https://creativecommons.org/faq/#artificial-intelligence-and-cc-licenses)

Suggested model-card text:

> Association parameters derived from the OPUS Tatoeba v2026-07-08 sentence collection, contributed by Tatoeba users and distributed by OPUS (Jörg Tiedemann), under Creative Commons Attribution 2.0 France. Transformation: normalization, grouping, train-only sparse statistical association learning and pruning. Source sentence texts are not included in this model artifact. Original source archives, SHA256 values and notices are recorded in the accompanying provenance manifest. No endorsement by Tatoeba or OPUS is implied.

## PMB semantic graph fixtures

The official PMB 4.0 sample has separate licenses for annotations and raw texts. The **annotations are ODC-BY 1.0**. Raw text licenses remain those of the component corpus.

`processed/pmb-shareable-graph-fixtures.json` selects 14 gold-annotation records: four German RTE, five Italian RTE, five Dutch RTE. Their included component READMEs explicitly license German/Italian raw texts as CC BY 3.0 and Dutch as CC BY 4.0. Source and contributor notices are retained in the JSON attribution object. Keep the following upstream files with a redistributed fixture bundle:

- `raw/pmb/licenses/PMB_LICENSE.txt`
- `raw/pmb/licenses/ODC-BY.txt`
- `raw/pmb/licenses/RTE3-DE-README.txt`
- `raw/pmb/licenses/RTE3-ITA-README.txt`
- `raw/pmb/licenses/RTE3-NL-README.txt`

Notice: Contains information from the Parallel Meaning Bank, made available under the Open Data Commons Attribution License (ODC-BY) v1.0. Texts retain the licenses listed above. The processing here converts original DRS clause notation to JSON and preserves per-layer annotation status, source document IDs and word-alignment spans. [ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/)

The sample's SICK texts carry a noncommercial license; English RTE text terms are unspecified in the accompanying metadata; Tatoeba author attribution has not been individually resolved. These records are excluded from the publishable fixture selection and remain solely in the original research archive/inspection JSON. Nothing in the annotation license silently overrides those text licenses.

These are fixtures for schema and graph rendering, not a held-out benchmark: they have been inspected during implementation. They should not produce an accuracy score or any claim that a model learned their meaning.
