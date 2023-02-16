function geoFindMe() {

  const status = document.querySelector('#status');
  const mapLink = document.querySelector('#map-link');

  mapLink.href = '';
  mapLink.textContent = '';

  function success(position) {
    const latitude  = position.coords.latitude;
    const longitude = position.coords.longitude;

    //status.textContent = '';
    mapLink.href = 'https://www.openstreetmap.org/#map=18/' + latitude + '/' + longitude;
    mapLink.textContent = 'Latitude: ' + latitude + ' °, Longitude: ' + longitude + ' °';
  }

  function error() {
    //status.textContent = 'Unable to retrieve your location';
    mapLink.textContent = 'Unable to retrieve your location';
  }

  if (!navigator.geolocation) {
//    status.textContent = 'Geolocation is not supported by your browser';
    mapLink.textContent = 'Geolocation is not supported by your browser';
  } else {
//    status.textContent = 'Locating…';
    mapLink.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(success, error);
  }

}

function showMap(){
 var linkObject = document.querySelector('#map-link');
 var aLinkParts = linkObject.href.split('/');
 const zoomlevel = 12;
 const longitude = aLinkParts.pop();
 const latitude = aLinkParts.pop();

  // Creating a map object
  var map = L.map('map').setView([latitude, longitude], zoomlevel);
 
  // Creating a Layer object
  var layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
 
  // Adding layer to the map
  map.addLayer(layer);
}
document.querySelector('#find-me').addEventListener('click', geoFindMe);
document.querySelector('#show-me').addEventListener('click', showMap);