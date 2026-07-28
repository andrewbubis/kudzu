/* ─────────────────────────────────────────────────────────────────────
   Shared form fields: birth year and country.

   Countries are the ISO 3166-1 list — every sovereign state plus the
   territories that show up in artist bios. Kept here rather than fetched
   so the form works offline and nothing external can change what your
   artists see.
   ───────────────────────────────────────────────────────────────────── */
(function (g) {
  'use strict';

  var COUNTRIES = [
    'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina',
    'Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados',
    'Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana',
    'Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia','Cameroon',
    'Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros',
    'Congo (Brazzaville)','Congo (Kinshasa)','Costa Rica','Côte d’Ivoire','Croatia','Cuba',
    'Cyprus','Czechia','Denmark','Djibouti','Dominica','Dominican Republic','Ecuador','Egypt',
    'El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland',
    'France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea',
    'Guinea-Bissau','Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran',
    'Iraq','Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati',
    'Kosovo','Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya',
    'Liechtenstein','Lithuania','Luxembourg','Madagascar','Malawi','Malaysia','Maldives','Mali',
    'Malta','Marshall Islands','Mauritania','Mauritius','Mexico','Micronesia','Moldova','Monaco',
    'Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nauru','Nepal',
    'Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia',
    'Norway','Oman','Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru',
    'Philippines','Poland','Portugal','Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis',
    'Saint Lucia','Saint Vincent and the Grenadines','Samoa','San Marino','São Tomé and Príncipe',
    'Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia',
    'Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka',
    'Sudan','Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand',
    'Timor-Leste','Togo','Tonga','Trinidad and Tobago','Tunisia','Türkiye','Turkmenistan','Tuvalu',
    'Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay',
    'Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe',
    // Territories and dependencies that appear on artist CVs
    'Bermuda','Faroe Islands','French Guiana','French Polynesia','Gibraltar','Greenland',
    'Guadeloupe','Guam','Hong Kong','Macau','Martinique','New Caledonia','Puerto Rico','Réunion',
    'Åland Islands'
  ].sort(function (a, b) { return a.localeCompare(b); });

  // A handful float to the top — where the roster actually lives.
  var PINNED = ['United States', 'Canada', 'Mexico', 'United Kingdom'];

  /**
   * Turn an <input> into a country picker. Uses a native <select> so it
   * gets the platform's own scrolling and type-to-jump on both desktop
   * and phone — better than any custom dropdown for a list this long.
   */
  g.countrySelect = function (input, opts) {
    if (!input) return null;
    opts = opts || {};

    var sel = document.createElement('select');
    sel.id = input.id;
    sel.name = input.name || input.id;
    sel.className = input.className;
    sel.style.cssText = input.style.cssText;

    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = opts.placeholder || 'Select a country…';
    sel.appendChild(blank);

    function add(name, group) {
      var o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      (group || sel).appendChild(o);
    }

    PINNED.forEach(function (c) { add(c); });

    var rule = document.createElement('option');
    rule.disabled = true;
    rule.textContent = '──────────';
    sel.appendChild(rule);

    COUNTRIES.forEach(function (c) {
      if (PINNED.indexOf(c) === -1) add(c);
    });

    input.parentNode.replaceChild(sel, input);
    return sel;
  };

  /**
   * Turn an <input> into a year picker. Newest first, since most artists
   * are living — scrolling to 1994 shouldn't mean passing 1900.
   */
  g.yearSelect = function (input, opts) {
    if (!input) return null;
    opts = opts || {};

    var now = new Date().getFullYear();
    var last = opts.last || now;
    var first = opts.first || 1900;

    var sel = document.createElement('select');
    sel.id = input.id;
    sel.name = input.name || input.id;
    sel.className = input.className;
    sel.style.cssText = input.style.cssText;

    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = opts.placeholder || 'Year';
    sel.appendChild(blank);

    for (var y = last; y >= first; y--) {
      var o = document.createElement('option');
      o.value = String(y);
      o.textContent = String(y);
      sel.appendChild(o);
    }

    input.parentNode.replaceChild(sel, input);
    return sel;
  };

  g.COUNTRIES = COUNTRIES;
})(window);
