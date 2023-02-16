var geoWatch;
function setCurrentPosition(position) {
  var locationList = document.querySelector('#location-list');
  if (locationList) {
    var tagA = "<a id=\"map-link\" target=\"_blank\" href=\"https://www.openstreetmap.org/#map=18/";
    tagA += position.coords.latitude;
    tagA += "/";
    tagA += position.coords.longitude;
    tagA += "\"> Latitude: ";
    tagA += position.coords.latitude;
    tagA += " °, Longitude: ";
    tagA += position.coords.longitude;
    tagA += " °</a><br/>";
    locationList.innerHTML += tagA;
  }
}

function positionError(error) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      console.error("User denied the request for Geolocation.");
      break;

    case error.POSITION_UNAVAILABLE:
      console.error("Location information is unavailable.");
      break;

    case error.TIMEOUT:
      console.error("The request to get user location timed out.");
      break;

    case error.UNKNOWN_ERROR:
      console.error("An unknown error occurred.");
      break;
  }
}

function startWatch() {
  document.querySelector('#location-list').childNodes = null;
  if (!geoWatch) {
    if ("geolocation" in navigator && "watchPosition" in navigator.geolocation) {
      geoWatch = navigator.geolocation.watchPosition(setCurrentPosition, positionError, {
        enableHighAccuracy: false, timeout: 15000, maximumAge: 0
      });
    }
  }
}

function stopWatch() {
  navigator.geolocation.clearWatch(geoWatch);
  geoWatch = undefined;
}

function geoFindMe() {
  document.querySelector('#location-list').innerHTML = "<a id=\"map-link\" target=\"_blank\"></a>";
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
document.querySelector('#follow-me').addEventListener('click', startWatch);
document.querySelector('#stop-follow-me').addEventListener('click', stopWatch);
document.querySelector('#show-me').addEventListener('click', showMap);