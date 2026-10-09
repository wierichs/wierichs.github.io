window.JAGDKARTE_CONFIG = {
  supabaseUrl: 'https://qgtgeawsdxynnqsuanbl.supabase.co',
  supabasePublishableKey: 'sb_publishable_McuMiwcFEHR1V6QjOksZPA_8OzhaYtX',
  markerTypesUrl: './marker-types.json',
  sources: [{
    id: 'bielefeld',
    label: 'Bielefeld, Nordrhein-Westfalen',
    type: 'wfs',
    url: 'https://bielefeld01.de/mdOLKD/WFS/jagdreviere/01',
    typeName: 'ms:jagdreviere_pl',
    outputFormat: 'application/json; subtype=geojson',
    nameFields: ['revierda_1', 'id'],
    attribution: 'Stadt Bielefeld, Amt fuer Geoinformation und Kataster',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.de',
    metadataUrl: 'https://www.bielefeld01.de/mdOLKD/Daten/jagdreviere_pl?FORMAT=HTML_Daten'
  }, {
    id: 'rhein-kreis-neuss',
    label: 'Rhein-Kreis Neuss, Nordrhein-Westfalen (Snapshot)',
    type: 'snapshot',
    url: './neuss.geojson',
    snapshotDate: '2026-10-08',
    nameFields: ['jagdbezirk'],
    attribution: 'Rhein-Kreis Neuss, Kataster- und Vermessungsamt',
    license: 'DL-DE-Zero-2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
    metadataUrl: 'https://maps.rhein-kreis-neuss.de/rknportale/Nutzungsbestimmungen.html'
  }, {
    id: 'kreis-viersen',
    label: 'Kreis Viersen, Nordrhein-Westfalen',
    type: 'ogcapi',
    url: 'https://gdi-api.krzn.de/kvie_jagdbezirke/collections/jagdbezirke/items?f=json&profile=rfc7946&limit=500',
    nameFields: ['name_jagdbezirk', 'nr_jagdbezirk'],
    attribution: 'Kreis Viersen',
    license: 'DL-DE-Zero-2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
    metadataUrl: 'https://registry.gdi-de.org/id/de.nw/4f72a38a-3e93-448d-ab81-b623c4f19e6a'
  }, {
    id: 'kreis-kleve',
    label: 'Kreis Kleve, Nordrhein-Westfalen',
    type: 'ogcapi',
    url: 'https://gdi-api.krzn.de/kkle_jagdbezirke/collections/jagdbezirke/items?f=json&profile=rfc7946&limit=500',
    nameFields: ['name_jagdbezirk', 'nr_jagdbezirk'],
    attribution: 'Kreis Kleve - Der Landrat',
    license: 'DL-DE-Zero-2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
    metadataUrl: 'https://registry.gdi-de.org/id/de.nw/d4598edd-4a6d-4482-8fc7-2294fe63ecbe'
  }, {
    id: 'krefeld',
    label: 'Krefeld, Nordrhein-Westfalen',
    type: 'ogcapi',
    url: 'https://gdi-api.krzn.de/skre_jagdbezirke/collections/jagdbezirke/items?f=json&profile=rfc7946&limit=500',
    nameFields: ['name_jagdbezirk', 'nr_jagdbezirk'],
    attribution: 'Stadt Krefeld',
    license: 'DL-DE-Zero-2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
    metadataUrl: 'https://registry.gdi-de.org/id/de.nw/4ed012ee-c397-4d91-bbe8-ba7f8888ebf6'
  }, {
    id: 'kreis-wesel',
    label: 'Kreis Wesel, Nordrhein-Westfalen',
    type: 'ogcapi',
    url: 'https://gdi-api.krzn.de/kwes_jagdbezirke/collections/jagdbezirke/items?f=json&profile=rfc7946&limit=500',
    nameFields: ['name_jagdbezirk', 'nr_jagdbezirk'],
    attribution: 'Kreis Wesel',
    license: 'DL-DE-Zero-2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
    metadataUrl: 'https://registry.gdi-de.org/id/de.nw/81d8ad75-417a-4cc2-a615-167b07e427fc'
  }, {
    id: 'trier',
    label: 'Trier, Rheinland-Pfalz',
    type: 'ogcapi',
    url: 'https://www.geoportal.rlp.de/spatial-objects/630/collections/ms:jagdbezirke/items?f=json&limit=500',
    idFields: ['ID1'],
    nameFields: ['Kurzname', 'Jagdbezirk', 'ID1'],
    attribution: 'Stadt Trier, www.trier.de',
    license: 'DL-DE-BY-2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/by-2-0',
    metadataUrl: 'https://www.geoportal.rlp.de/mapbender/php/mod_showMetadata.php?languageCode=de&resource=layer&layout=tabs&id=81585'
  }]
};