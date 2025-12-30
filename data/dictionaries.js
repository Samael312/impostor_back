// backend/data/dictionaries.js

const DICTIONARIES = {
  venezolano: [
    "Hallaca", "Sifrino", "Patacón",
    "Cachapa", "Tequeños", "CLAP",
    "Enchufado", "Pepito", "Saime",
    "Chicha", "Malta", "Frescolita",
    "Encava", "Polar", "Toddy", "Maria Corina Machado", 
    "Diosdado Cabello", "Henrique Capriles"
  ],

  animales: [
    "Panda", "Jirafa", "Elefante",
    "León", "Tigre", "Delfín",
    "Tiburón", "Canguro", "Koala",
    "Pingüino", "Águila", "Lobo"
  ],

  cultura_pop: [
    "Star Wars", "Harry Potter", "Marvel",
    "DC", "Stranger Things", "Game of Thrones",
    "Netflix", "Disney+", "Game of Thrones",
    "Donald Trump", "Elon Musk", "Sidney Sweeney"
  ],

  fiestas: [
    "Navidad", "Año Nuevo", "Reyes Magos",
    "San Valentín", "Halloween", "Carnavales",
    "Cumpleaños", "Quinceaños", "Boda",
    "Graduación", "Baby Shower"
  ],

  objetos: [
    "iPhone", "AirPods", "PlayStation",
    "Xbox", "Nintendo Switch", "Laptop",
    "Audífonos Bluetooth", "Smartwatch",
    "Cámara GoPro", "Tablet", "Kindle"
  ],

  comida_internacional: [
    "Pizza", "Hamburguesa", "Sushi",
    "Tacos", "Ramen", "Lasagna",
    "Paella", "Burrito", "Shawarma",
    "Hot Dog"
  ],

  ropa: [
    "Jeans", "Hoodie", "Chaqueta de Cuero",
    "Franela Oversize", "Zapatillas Nike",
    "Zapatos Jordan", "Vestido",
    "Traje", "Gorra", "Lentes de Sol"
  ],

  dificil: [ // Muy parecidas para confundir al impostor
    "Hallaca", "Sifrino", "Sidney Sweeney",
    "Panda", "Koala", "Oso Polar",
    "Star Wars", "Star Trek", "Guardianes de la Galaxia",
    "Navidad", "Año Nuevo", "Nochebuena"
  ]
};



// Función para obtener una palabra aleatoria según categoría
const getRandomWord = (category = 'random') => {
  // Si la categoría no existe o es 'random', elegimos una clave al azar
  let selectedCategory = category;
  const keys = Object.keys(DICTIONARIES);

  if (category === 'random' || !DICTIONARIES[category]) {
    selectedCategory = keys[Math.floor(Math.random() * keys.length)];
  }

  const wordList = DICTIONARIES[selectedCategory];
  const word = wordList[Math.floor(Math.random() * wordList.length)];

  return { word, category: selectedCategory };
};

module.exports = { DICTIONARIES, getRandomWord };